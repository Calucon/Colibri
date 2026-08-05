using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public enum ConnectionStatus { Connected, Disconnected, Connecting, Reconnecting };

    /// <summary>
    /// TCP connection to a colibri-server, speaking the v3 binary protocol
    /// (see <see cref="Protocol.FrameCodec"/> and <c>colibri-server/docs/protocol.md</c>).
    ///
    /// Requires colibri-server >= 2.0.0; there is no version negotiation, so a 1.x server
    /// cannot be talked to at all.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class WebServerConnection : SingletonBehaviour<WebServerConnection>
    {
        /// <summary>
        /// Client library version announced in the handshake. Matches colibri-web's
        /// <c>query: { app, version: '2' }</c>. The server does not validate it - it is
        /// metadata shown on the admin UI's Clients page.
        /// </summary>
        private const string CLIENT_VERSION = "2";

        /// <summary>
        /// The server heartbeats every 100 ms, so silence for this long means the connection
        /// is gone even if the socket has not noticed yet.
        /// </summary>
        private const long HEARTBEAT_TIMEOUT_THRESHOLD_MS = 2000;

        private const int RECEIVE_BUFFER_SIZE = 64 * 1024;
        private const int RECONNECT_DELAY_MIN_MS = 500;
        private const int RECONNECT_DELAY_MAX_MS = 10 * 1000;

        /// <summary>
        /// Retry queue bound. This is a last-write-wins sync client: growing the queue without
        /// limit during a long outage would only buffer updates that are already superseded.
        /// </summary>
        private const int MAX_QUEUED_MESSAGES = 256;

        /// <summary>
        /// ClientLogger (<c>client-logger.ts</c>) reads this channel's payload with
        /// <c>asString()</c>, so it is the one channel that ships raw text instead of JSON -
        /// quoting it would put stray quotes in the admin UI's log page.
        /// </summary>
        private const string LOG_CHANNEL = "log";

        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        public delegate void MessageAction(string channel, string command, JToken payload);
        public event MessageAction OnMessageReceived;
        public event Action OnConnected;
        public event Action OnDisconnected;

        // Instance, not static: static state survives Enter Play Mode with domain reload
        // disabled and would leave a second play session talking to a dead socket.
        private Socket _socket;
        private CancellationTokenSource _lifetime;
        private string _hostname = "";

        // Serializes every write to the socket. Concurrent SendCommandAsync calls used to
        // interleave their bytes and corrupt the framing for everything that followed.
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

        // Written from the send path, drained from the connect path - both off the main
        // thread, so it needs a lock (it had none).
        private readonly List<byte[]> _msgQueue = new List<byte[]>();
        private readonly object _msgQueueLock = new object();

        private readonly LockFreeQueue<InPacket> _queuedCommands = new LockFreeQueue<InPacket>();
        private long _lastHeartbeatTime;
        private int _connectAttempts;
        private bool _hasReportedMissingConfig;

        // ColibriConfig.Load() goes through Resources.Load, which is main-thread only, so the
        // connection loop reads this snapshot instead of the ScriptableObject.
        private volatile string _serverAddress;
        private volatile string _appName;
        private volatile int _tcpPort;

        // Gate that `await Connected` waits on, replacing the UniRx IObservable<bool> awaiter -
        // no Rx on the send hot path. Deliberately a TaskCompletionSource and not a
        // UniTaskCompletionSource: several SendCommandAsync calls routinely wait on this at once
        // (a SyncBehaviour pushes one update per synced attribute at startup), and a
        // UniTaskCompletionSource throws "can not await twice" on the second pending awaiter.
        private TaskCompletionSource<bool> _connectedGate = NewGate();
        private volatile bool _isGateOpen;
        public Task Connected => _connectedGate.Task;

        private static TaskCompletionSource<bool> NewGate()
            => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        // workaround to execute events in main unity thread
        private volatile bool _fireOnConnected;
        private volatile bool _fireOnDisconnected;

        private ConnectionStatus _status = ConnectionStatus.Disconnected;
        public ConnectionStatus Status
        {
            get { return _status; }
            private set
            {
                if (_status == value)
                    return;

                _status = value;

                if (_status == ConnectionStatus.Connected)
                {
                    _connectAttempts = 0;
                    _fireOnConnected = true;
                    _isGateOpen = true;
                    _connectedGate.TrySetResult(true);
                }
                else if (_isGateOpen)
                {
                    // Re-arm the gate so a send issued while disconnected waits for the next
                    // successful connection instead of racing straight onto a dead socket.
                    _isGateOpen = false;
                    _connectedGate = NewGate();
                }

                if (_status == ConnectionStatus.Disconnected)
                    _fireOnDisconnected = true;
            }
        }

        private struct InPacket
        {
            public string Channel;
            public string Command;
            public JToken Payload;
        }


        private void OnEnable()
        {
            DontDestroyOnLoad(this);

            // Can only be read from the main thread.
            _hostname = SanitizeHandshakeField(SystemInfo.deviceName);
            RefreshConfig();

            _connectedGate = NewGate();
            _isGateOpen = false;

            _lifetime = new CancellationTokenSource();
            _ = RunConnectionLoop(_lifetime.Token);
        }

        private void RefreshConfig()
        {
            // Never null - an unconfigured project gets the defaults, and the empty app name is
            // what RunConnectionLoop reports and waits on.
            var config = ColibriConfig.Load();

            _serverAddress = config.ServerAddress;
            _appName = config.AppName;
            _tcpPort = config.TcpServerPort;
        }

        private void OnDisable()
        {
            _lifetime?.Cancel();
            _lifetime?.Dispose();
            _lifetime = null;

            CloseSocket(_socket);
            _socket = null;

            _connectedGate.TrySetCanceled();
            Status = ConnectionStatus.Disconnected;
        }

        private void Update()
        {
            RefreshConfig();

            if (_fireOnConnected)
            {
                _fireOnConnected = false;
                OnConnected?.Invoke();
            }

            if (_fireOnDisconnected)
            {
                _fireOnDisconnected = false;
                OnDisconnected?.Invoke();
            }

            // Handlers run on the main thread to keep threading issues out of user code.
            while (_queuedCommands.Dequeue(out var packet))
                OnMessageReceived?.Invoke(packet.Channel, packet.Command, packet.Payload);

            if (Status == ConnectionStatus.Connected && MillisSinceLastHeartbeat() > HEARTBEAT_TIMEOUT_THRESHOLD_MS)
            {
                Debug.Log("Colibri: no heartbeat from the server, dropping the connection");
                // Flip the status first so this does not re-fire every frame while the session
                // unwinds, then fault the receive loop into the reconnect backoff below.
                Status = ConnectionStatus.Disconnected;
                CloseSocket(_socket);
            }
        }


        /*
         *  Connection lifecycle
         */

        // One long-lived task per component lifetime, instead of Update() re-entering
        // Connect() every frame while disconnected.
        private async Task RunConnectionLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                var address = _serverAddress;
                var app = _appName;

                if (string.IsNullOrEmpty(address) || string.IsNullOrEmpty(app))
                {
                    // Nothing configured (yet) - poll rather than give up, so setting the app
                    // name at runtime still connects. Said once, not twice a second.
                    if (!_hasReportedMissingConfig)
                    {
                        _hasReportedMissingConfig = true;
                        Debug.LogError(ColibriConfig.NOT_CONFIGURED_MESSAGE);
                    }

                    if (!await Delay(RECONNECT_DELAY_MIN_MS, token))
                        break;
                    continue;
                }

                _hasReportedMissingConfig = false;

                try
                {
                    await RunSession(address, _tcpPort, SanitizeHandshakeField(app), token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (FrameException e)
                {
                    // A desynchronized stream cannot be recovered from - there is no delimiter
                    // to resynchronize on - so the connection is dropped and rebuilt.
                    Debug.LogError($"Colibri: invalid frame from server, dropping connection: {e.Message}");
                }
                catch (SocketException e)
                {
                    Debug.Log($"Colibri: connection to {address} failed ({e.SocketErrorCode}), retrying...");
                }
                catch (ObjectDisposedException)
                {
                    // Socket closed underneath us by OnDisable or the heartbeat watchdog.
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
                finally
                {
                    CloseSocket(_socket);
                    _socket = null;
                    Status = ConnectionStatus.Disconnected;
                }

                if (token.IsCancellationRequested)
                    break;

                if (!await Delay(NextBackoffDelay(), token))
                    break;
            }
        }

        private async Task RunSession(string host, int port, string app, CancellationToken token)
        {
            Status = _connectAttempts == 0 ? ConnectionStatus.Connecting : ConnectionStatus.Reconnecting;
            Debug.Log($"Colibri: connecting to {host}:{port}");

            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            _socket = socket;

            // Closing the socket is what unblocks an in-flight ReceiveAsync/SendAsync; there is
            // no cancellation token overload for either on this API surface.
            using (token.Register(() => CloseSocket(socket)))
            {
                await socket.ConnectAsync(host, port);
                token.ThrowIfCancellationRequested();

                StampLiveness();
                await SendFrame(socket, FrameCodec.EncodeHandshake(CLIENT_VERSION, app, _hostname), token);

                // The app name is named explicitly: a typo in it produces a perfectly healthy
                // connection on which no other client is ever seen.
                Debug.Log($"Colibri: connected to {host}:{port} as app '{app}'. Only clients using the same App Name can see each other.");

                // Drain anything queued during the outage before opening the gate, so retried
                // messages stay ahead of new ones.
                await FlushQueue(socket, token);
                Status = ConnectionStatus.Connected;

                await ReceiveLoop(socket, token);
            }
        }

        private async Task ReceiveLoop(Socket socket, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[RECEIVE_BUFFER_SIZE];

            while (!token.IsCancellationRequested)
            {
                var received = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), SocketFlags.None);
                if (received <= 0)
                {
                    Debug.Log("Colibri: server closed the connection");
                    return;
                }

                // The server heartbeats every 100 ms whether or not there is traffic, so any
                // received byte is proof of life.
                StampLiveness();

                var frames = ReadFrames(reader, buffer, received);
                for (var i = 0; i < frames.Count; i++)
                {
                    var frame = frames[i];
                    switch (frame.Type)
                    {
                        case FrameType.Heartbeat:
                            // Echoed back verbatim - the u64 is the server's own monotonic clock
                            // reading and is never interpreted here. Since 2.0.0 this echo is the
                            // sole source of the server's TCP latency measurements; the old
                            // `colibri`/`latency` message echo is Socket.IO-only and nothing
                            // sends it to a TCP client any more.
                            await SendFrame(socket, FrameCodec.EncodeHeartbeat(frame.PingTimestamp), token);
                            break;

                        case FrameType.Message:
                            _queuedCommands.Enqueue(new InPacket
                            {
                                Channel = frame.Channel,
                                Command = frame.Command,
                                Payload = ParsePayload(frame.Payload)
                            });
                            break;

                        case FrameType.Handshake:
                            // Server -> client handshakes are not part of the protocol.
                            Debug.LogWarning("Colibri: ignoring unexpected handshake frame from server");
                            break;
                    }
                }
            }

            token.ThrowIfCancellationRequested();
        }

        // Kept out of the async method above: a ReadOnlySpan<byte> local may not live inside
        // an async state machine.
        private static IReadOnlyList<DecodedFrame> ReadFrames(FrameReader reader, byte[] buffer, int count)
            => reader.Append(new ReadOnlySpan<byte>(buffer, 0, count));

        private int NextBackoffDelay()
        {
            var shift = Math.Min(_connectAttempts, 5);
            _connectAttempts++;
            return Math.Min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_MIN_MS << shift);
        }

        /// <returns><c>false</c> if the wait was cancelled - i.e. the caller should stop looping.</returns>
        private static async Task<bool> Delay(int delayMs, CancellationToken token)
        {
            try
            {
                await Task.Delay(delayMs, token);
                return true;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }

        private static void CloseSocket(Socket socket)
        {
            if (socket == null)
                return;

            try
            {
                socket.Close();
            }
            catch (ObjectDisposedException)
            {
                // Already closed - closing is idempotent by design here, since both OnDisable
                // and the heartbeat watchdog can race the session's own teardown.
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Colibri: error while closing socket: {e.Message}");
            }
        }

        private void StampLiveness() => Interlocked.Exchange(ref _lastHeartbeatTime, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

        /// <summary>
        /// How long ago the server was last heard from. Not a round-trip latency: the server's
        /// heartbeat carries the server's own clock, so the client cannot derive an RTT from it.
        /// Real latency figures live on the server's admin UI.
        /// </summary>
        public long MillisSinceLastHeartbeat() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Interlocked.Read(ref _lastHeartbeatTime);

        /// <summary>Server the connection loop is currently using, as configured.</summary>
        public string ServerAddress => _serverAddress;

        /// <summary>TCP port the connection loop is currently using.</summary>
        public int TcpPort => _tcpPort;

        /// <summary>App name this client identifies as. Only clients sharing it can see each other.</summary>
        public string AppName => _appName;

        /// <summary>Client-library protocol version sent in the handshake.</summary>
        public static string ClientVersion => CLIENT_VERSION;


        /*
         *  Sending
         */

        // All socket writes funnel through here so that a frame is never interleaved with
        // another frame's bytes, and so that a partial send is completed rather than silently
        // truncating the frame.
        private async Task SendFrame(Socket socket, byte[] frame, CancellationToken token)
        {
            await _sendLock.WaitAsync(token);
            try
            {
                var offset = 0;
                while (offset < frame.Length)
                {
                    var sent = await socket.SendAsync(new ArraySegment<byte>(frame, offset, frame.Length - offset), SocketFlags.None);
                    if (sent <= 0)
                        throw new SocketException((int)SocketError.ConnectionReset);

                    offset += sent;
                }
            }
            finally
            {
                _sendLock.Release();
            }
        }

        private async Task<bool> TrySendFrame(byte[] frame)
        {
            var socket = _socket;
            if (socket == null || Status != ConnectionStatus.Connected)
                return false;

            try
            {
                await SendFrame(socket, frame, _lifetime?.Token ?? CancellationToken.None);
                return true;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Colibri: failed to send frame: {e.Message}");
                return false;
            }
        }

        private async Task FlushQueue(Socket socket, CancellationToken token)
        {
            while (true)
            {
                byte[] frame;
                lock (_msgQueueLock)
                {
                    if (_msgQueue.Count == 0)
                        return;
                    frame = _msgQueue[0];
                }

                await SendFrame(socket, frame, token);

                lock (_msgQueueLock)
                {
                    // The frame may already be gone if the queue was trimmed meanwhile.
                    if (_msgQueue.Count > 0 && ReferenceEquals(_msgQueue[0], frame))
                        _msgQueue.RemoveAt(0);
                }
            }
        }

        private void EnqueueForRetry(byte[] frame)
        {
            lock (_msgQueueLock)
            {
                _msgQueue.Add(frame);
                if (_msgQueue.Count > MAX_QUEUED_MESSAGES)
                    _msgQueue.RemoveRange(0, _msgQueue.Count - MAX_QUEUED_MESSAGES);
            }
        }

        public async Task<bool> SendCommandAsync(string channel, string command, JToken payload)
        {
            byte[] frame;
            try
            {
                frame = FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException e)
            {
                // One unrepresentable message is dropped as one bad message, exactly as the
                // server does on its own egress path.
                Debug.LogError($"Colibri: dropping unencodable message ({channel} / {command}): {e.Message}");
                return false;
            }

            try
            {
                await Connected;
            }
            catch (OperationCanceledException)
            {
                return false;
            }

            if (await TrySendFrame(frame))
                return true;

            EnqueueForRetry(frame);
            return false;
        }

        public void SendCommand(string channel, string command, JToken payload)
        {
            _ = SendCommandAsync(channel, command, payload);
        }


        /*
         *  Payload encoding
         */

        private static byte[] EncodePayload(string channel, JToken payload)
        {
            if (payload == null || payload.Type == JTokenType.Null)
                return Array.Empty<byte>();

            // Everything except the log channel goes out as JSON. Writing a string payload
            // unquoted (as v1 did) is not valid JSON, so the server's Payload.asValue() threw
            // and fell back to asString() - meaning a Unity string and a web client's string
            // did not round-trip identically.
            if (channel == LOG_CHANNEL)
                return Utf8.GetBytes(payload.Type == JTokenType.String ? payload.Value<string>() : payload.ToString(Formatting.None));

            return Utf8.GetBytes(payload.ToString(Formatting.None));
        }

        private static JToken ParsePayload(byte[] payload)
        {
            if (payload == null || payload.Length == 0)
                return JValue.CreateNull();

            var text = Utf8.GetString(payload);
            try
            {
                return JToken.Parse(text);
            }
            catch (JsonException)
            {
                // A non-JSON body (e.g. a raw log line) is still delivered, as a raw string.
                return new JValue(text);
            }
        }

        // '::' is the handshake field separator; a device or app name containing one would
        // produce a frame the server rejects outright.
        private static string SanitizeHandshakeField(string value)
            => string.IsNullOrEmpty(value) ? value : value.Replace(FrameCodec.FieldSeparator, "_");
    }
}
