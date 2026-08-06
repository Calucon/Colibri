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
    /// <summary>
    /// <see cref="ConnectionStatus.ProtocolMismatch"/> is terminal: unlike
    /// <see cref="ConnectionStatus.Disconnected"/> it is never followed by another attempt,
    /// because a version mismatch cannot resolve itself.
    /// </summary>
    public enum ConnectionStatus { Connected, Disconnected, Connecting, Reconnecting, ProtocolMismatch };

    /// <summary>
    /// TCP connection to a colibri-server, speaking the v3 binary protocol
    /// (see <see cref="Protocol.FrameCodec"/> and <c>colibri-server/docs/protocol.md</c>).
    ///
    /// Requires colibri-server >= 2.0.0. There is no version negotiation: the server accepts
    /// exactly one protocol version and refuses anything else, so both sides have to be
    /// upgraded together.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class WebServerConnection : SingletonBehaviour<WebServerConnection>
    {
        /// <summary>
        /// Protocol version announced in the handshake. Matches colibri-web's
        /// <c>query: { app, version: '2' }</c> and <c>PROTOCOL_VERSION</c> in the server's
        /// <c>src/server/modules/networking/protocol.ts</c>. A server speaking anything else
        /// refuses the connection with a <see cref="PROTOCOL_REJECTED_COMMAND"/> message.
        /// </summary>
        private const string CLIENT_VERSION = "2";

        /// <summary>
        /// Channel and command the server refuses a mismatched client on. Handled here rather
        /// than in <c>Sync</c>: it is Colibri's own plumbing, not an application message.
        /// </summary>
        private const string COLIBRI_CHANNEL = "colibri";
        private const string PROTOCOL_REJECTED_COMMAND = "protocol::rejected";

        /// <summary>
        /// A server on a genuinely different framing cannot be told anything - it cannot decode
        /// our frames and we cannot decode its. What that looks like from here is a session that
        /// faults before a single frame is read, over and over. After this many in a row, say so:
        /// the alternative is an infinite reconnect loop whose log gives no hint of the cause.
        /// </summary>
        private const int EARLY_FRAME_FAILURES_BEFORE_HINT = 3;

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
        //
        // volatile: written by the connection loop off the main thread, read by Update()'s
        // heartbeat watchdog and by the send path.
        private volatile Socket _socket;
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

        // Both touched from the connection loop and from Update() via the Status setter, so
        // every access to them is under _statusLock.
        private int _connectAttempts;

        // Connection loop only.
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
        //
        // volatile because the gate is re-armed on the connection loop's thread while a sender
        // on any other thread may be reading it to await.
        private volatile TaskCompletionSource<bool> _connectedGate = NewGate();
        private volatile bool _isGateOpen;
        public Task Connected => _connectedGate.Task;

        private static TaskCompletionSource<bool> NewGate()
            => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        // workaround to execute events in main unity thread
        private volatile bool _fireOnConnected;
        private volatile bool _fireOnDisconnected;

        /// <summary>
        /// Smoothed rate at which <see cref="Update"/> runs, which is the rate at which received
        /// messages are handed to user code. Zero until the first few frames have been measured.
        /// </summary>
        /// <remarks>
        /// Not a diagnostic of the network. Once the socket is off the main thread the remaining
        /// delivery delay is entirely the local frame time, and an Editor in the background is
        /// throttled hard enough for that to be the dominant term - which looks exactly like a
        /// slow connection unless something says otherwise.
        /// </remarks>
        public float DeliveryFramesPerSecond => _smoothedDeltaTime > 0f ? 1f / _smoothedDeltaTime : 0f;

        private float _smoothedDeltaTime;

        /// <summary>
        /// Thread the receive loop last ran on, or 0 before the first receive. Exists so the test
        /// suite can assert the loop is not on the main thread; nothing in the library reads it.
        /// </summary>
        internal int ReceiveThreadId => _receiveThreadId;
        private volatile int _receiveThreadId;

        private volatile ConnectionStatus _status = ConnectionStatus.Disconnected;

        // Written by the receive loop off the main thread, read by the Editor status window and
        // by user code on the main thread.
        private volatile string _serverVersion;
        private volatile string _protocolMismatchReason;

        // Session-scoped: reset when a session starts, set once it has decoded anything at all.
        // Only a session that fails *before* this is set counts towards the framing hint.
        private volatile bool _decodedAnyFrame;
        private int _consecutiveEarlyFrameFailures;
        private volatile string _suspectedProtocolMismatch;

        // Session-scoped: set once the TCP connection is up and this client has sent its
        // handshake. Without it, a session that never got that far - "connection refused" because
        // the server simply is not running - would count towards the framing hint and have this
        // client blaming a version mismatch for a server that is switched off.
        private volatile bool _reachedHandshake;

        // The setter is a read-modify-write over four fields, and the connection loop and
        // Update()'s heartbeat watchdog can both reach it at the same time. Interleaved, the two
        // can lose a transition - the watchdog's Disconnected landing between the loop's compare
        // and its assignment leaves the gate open on a socket that is already closed.
        private readonly object _statusLock = new object();

        public ConnectionStatus Status
        {
            get { return _status; }
            private set
            {
                lock (_statusLock)
                {
                    if (_status == value)
                        return;

                    _status = value;

                    if (_status == ConnectionStatus.Connected)
                    {
                        _connectAttempts = 0;
                        _fireOnConnected = true;
                        _isGateOpen = true;

                        // The gate is created with RunContinuationsAsynchronously, so no waiting
                        // sender resumes inline here and none of them runs while holding the lock.
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
            TrackDeliveryRate();

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

        /// <summary>
        /// Measured here rather than anywhere else because this is the very method that drains
        /// <c>_queuedCommands</c>: it reports the rate messages are actually delivered at, not
        /// something adjacent to it.
        /// </summary>
        private void TrackDeliveryRate()
        {
            // unscaledDeltaTime, so a paused or slowed timeScale is not read as a stalled client.
            var delta = Time.unscaledDeltaTime;

            // Exponential moving average: a single long frame should show up, but not make the
            // readout jump around so much that it cannot be read.
            _smoothedDeltaTime = _smoothedDeltaTime <= 0f
                ? delta
                : Mathf.Lerp(_smoothedDeltaTime, delta, 0.1f);
        }


        /*
         *  Connection lifecycle
         */

        /*
         *  ConfigureAwait(false) on every await from here down, without exception.
         *
         *  This loop is started from OnEnable, i.e. on the main thread, so without it the first
         *  await captures Unity's SynchronizationContext and every continuation in the chain -
         *  connect, receive, heartbeat echo, send - is posted back to the main thread and pumped
         *  once per frame. Inbound bytes then sit in the kernel buffer until the next frame, the
         *  heartbeat echo costs two more frame-pumps *inside* the receive loop, and StampLiveness
         *  only runs when the main thread runs.
         *
         *  An unfocused Editor throttles its player loop, so that one cause produced both halves
         *  of the reported symptom: sync that visibly lagged between two editors side by side,
         *  and missed heartbeats on whichever one was in the background.
         *
         *  The main-thread handoff that user code needs is elsewhere and stays where it is:
         *  received messages go through _queuedCommands and are delivered from Update().
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

                    if (!await Delay(RECONNECT_DELAY_MIN_MS, token).ConfigureAwait(false))
                        break;
                    continue;
                }

                _hasReportedMissingConfig = false;

                var mismatched = false;

                try
                {
                    _decodedAnyFrame = false;
                    _reachedHandshake = false;
                    await RunSession(address, _tcpPort, SanitizeHandshakeField(app), token)
                        .ConfigureAwait(false);

                    // Reached only when ReceiveLoop returned, which it does on a clean EOF. A
                    // server that took the connection, said nothing and hung up looks exactly
                    // like a success here, so this cannot simply reset the counter - that is the
                    // other half of the symptom the hint exists to name.
                    ReportRepeatedEarlyFrameFailures();
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (ProtocolMismatchException e)
                {
                    mismatched = true;
                    Debug.LogError(
                        $"Colibri: the server refused this client - {e.Message}. " +
                        $"Update colibri-unity and colibri-server to matching versions. Not reconnecting.");
                }
                catch (FrameException e)
                {
                    // A desynchronized stream cannot be recovered from - there is no delimiter
                    // to resynchronize on - so the connection is dropped and rebuilt.
                    Debug.LogError($"Colibri: invalid frame from server, dropping connection: {e.Message}");
                    ReportRepeatedEarlyFrameFailures();
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
                    Status = mismatched ? ConnectionStatus.ProtocolMismatch : ConnectionStatus.Disconnected;
                }

                // Terminal. Retrying cannot make the two sides agree, and a reconnect loop would
                // only bury the one log line that explains what is wrong.
                if (mismatched)
                    break;

                if (token.IsCancellationRequested)
                    break;

                if (!await Delay(NextBackoffDelay(), token).ConfigureAwait(false))
                    break;
            }
        }

        /// <summary>
        /// A server whose framing this client cannot decode also cannot decode ours, so it has
        /// no way to send the explicit refusal. Repeated failures before a single frame is read
        /// are the only symptom that case has, so name the likely cause instead of logging the
        /// same decode error forever.
        ///
        /// This is a suspicion, not a finding: it cannot tell an out-of-date server apart from a
        /// TCP port that is not Colibri at all. So it stays a warning, the connection keeps being
        /// retried, and <see cref="Status"/> is left alone - only a refusal this client actually
        /// decoded is terminal.
        /// </summary>
        private void ReportRepeatedEarlyFrameFailures()
        {
            // Never got as far as a connected socket: that is a server that is down, a wrong
            // address or a closed port, and has nothing to say about protocol versions.
            if (!_reachedHandshake)
                return;

            if (_decodedAnyFrame)
            {
                _consecutiveEarlyFrameFailures = 0;
                _suspectedProtocolMismatch = null;
                return;
            }

            _consecutiveEarlyFrameFailures++;
            if (_consecutiveEarlyFrameFailures != EARLY_FRAME_FAILURES_BEFORE_HINT)
                return;

            _suspectedProtocolMismatch =
                $"{_consecutiveEarlyFrameFailures} connections in a row were accepted but ended before a single frame could be read. " +
                $"This usually means a protocol mismatch: this client speaks v{CLIENT_VERSION} and needs colibri-server >= 2.0.0.";

            Debug.LogError($"Colibri: {_suspectedProtocolMismatch} Check the server's version.");
        }

        private async Task RunSession(string host, int port, string app, CancellationToken token)
        {
            bool firstAttempt;
            lock (_statusLock)
                firstAttempt = _connectAttempts == 0;

            Status = firstAttempt ? ConnectionStatus.Connecting : ConnectionStatus.Reconnecting;
            Debug.Log($"Colibri: connecting to {host}:{port}");

            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            _socket = socket;

            // Closing the socket is what unblocks an in-flight ReceiveAsync/SendAsync; there is
            // no cancellation token overload for either on this API surface.
            using (token.Register(() => CloseSocket(socket)))
            {
                await socket.ConnectAsync(host, port).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();

                StampLiveness();
                await SendFrame(socket, FrameCodec.EncodeHandshake(CLIENT_VERSION, app, _hostname), token)
                    .ConfigureAwait(false);
                // Past this point the connection was accepted and this client has spoken, so a
                // session that now ends without a frame is a statement about the server.
                _reachedHandshake = true;

                // The app name is named explicitly: a typo in it produces a perfectly healthy
                // connection on which no other client is ever seen.
                Debug.Log($"Colibri: connected to {host}:{port} as app '{app}'. Only clients using the same App Name can see each other.");

                // Drain anything queued during the outage before opening the gate, so retried
                // messages stay ahead of new ones.
                await FlushQueue(socket, token).ConfigureAwait(false);
                Status = ConnectionStatus.Connected;

                await ReceiveLoop(socket, token).ConfigureAwait(false);
            }
        }

        private async Task ReceiveLoop(Socket socket, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[RECEIVE_BUFFER_SIZE];

            while (!token.IsCancellationRequested)
            {
                var received = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), SocketFlags.None)
                    .ConfigureAwait(false);
                if (received <= 0)
                {
                    Debug.Log("Colibri: server closed the connection");
                    return;
                }

                _receiveThreadId = Thread.CurrentThread.ManagedThreadId;

                // The server heartbeats every 100 ms whether or not there is traffic, so any
                // received byte is proof of life.
                StampLiveness();

                var frames = ReadFrames(reader, buffer, received);
                if (frames.Count > 0)
                    _decodedAnyFrame = true;

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
                            await SendFrame(socket, FrameCodec.EncodeHeartbeat(frame.PingTimestamp), token)
                                .ConfigureAwait(false);
                            break;

                        case FrameType.Message:
                            // Intercepted before the queue: a refusal is Colibri's own plumbing,
                            // and delivering it as an ordinary message would leave every
                            // application to recognize it for itself. Throws, so the session
                            // unwinds through the one place that decides whether to retry.
                            if (frame.Channel == COLIBRI_CHANNEL && frame.Command == PROTOCOL_REJECTED_COMMAND)
                                throw BuildProtocolMismatch(frame.Payload);

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

        /// <summary>
        /// Reads the server's refusal payload. Deliberately forgiving about its shape: the whole
        /// point of this path is to explain a mismatch, so a payload that is missing or is not
        /// the JSON we expect must still produce a usable message rather than a parse error that
        /// buries the real problem.
        /// </summary>
        private ProtocolMismatchException BuildProtocolMismatch(byte[] payload)
        {
            var serverVersion = "unknown";
            string reason = null;

            try
            {
                if (ParsePayload(payload) is JObject body)
                {
                    serverVersion = (string)body["serverVersion"] ?? serverVersion;
                    reason = (string)body["reason"];
                }
            }
            catch (Exception)
            {
                // Fall through to the generic wording below.
            }

            reason ??= $"the server speaks protocol v{serverVersion}, this client speaks v{CLIENT_VERSION}";

            _serverVersion = serverVersion;
            _protocolMismatchReason = reason;

            return new ProtocolMismatchException(reason, serverVersion, CLIENT_VERSION);
        }

        // Kept out of the async method above: a ReadOnlySpan<byte> local may not live inside
        // an async state machine.
        private static IReadOnlyList<DecodedFrame> ReadFrames(FrameReader reader, byte[] buffer, int count)
            => reader.Append(new ReadOnlySpan<byte>(buffer, 0, count));

        private int NextBackoffDelay()
        {
            // Same lock as the Status setter, which resets the counter on a successful connect.
            lock (_statusLock)
            {
                var shift = Math.Min(_connectAttempts, 5);
                _connectAttempts++;
                return Math.Min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_MIN_MS << shift);
            }
        }

        /// <returns><c>false</c> if the wait was cancelled - i.e. the caller should stop looping.</returns>
        private static async Task<bool> Delay(int delayMs, CancellationToken token)
        {
            try
            {
                await Task.Delay(delayMs, token).ConfigureAwait(false);
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

        /// <summary>
        /// Protocol version the server reported when it refused this client, or null while no
        /// refusal has been received. Only ever set alongside
        /// <see cref="ConnectionStatus.ProtocolMismatch"/>: a server that accepts the connection
        /// never sends its version, because there is nothing to report.
        /// </summary>
        public string ServerVersion => _serverVersion;

        /// <summary>
        /// Why the server refused this client, or null if it has not. Companion to
        /// <see cref="ConnectionStatus.ProtocolMismatch"/> for anything that wants to show the
        /// reason rather than just the state.
        /// </summary>
        public string ProtocolMismatchReason => _protocolMismatchReason;

        /// <summary>
        /// Why a protocol mismatch is *suspected*, or null if it is not. Set when several
        /// connections in a row were accepted but ended before a frame could be read - the only
        /// symptom available when the server's framing differs so much that it cannot send, and
        /// this client cannot decode, the explicit refusal.
        ///
        /// Unlike <see cref="ProtocolMismatchReason"/> this is a guess, not something the server
        /// said: it reads the same whether the server is out of date or the address points at
        /// something that is not Colibri at all. The connection keeps being retried, and
        /// <see cref="Status"/> is unaffected. Cleared as soon as any frame decodes.
        /// </summary>
        public string SuspectedProtocolMismatch => _suspectedProtocolMismatch;


        /*
         *  Sending
         */

        // All socket writes funnel through here so that a frame is never interleaved with
        // another frame's bytes, and so that a partial send is completed rather than silently
        // truncating the frame.
        private async Task SendFrame(Socket socket, byte[] frame, CancellationToken token)
        {
            await _sendLock.WaitAsync(token).ConfigureAwait(false);
            try
            {
                var offset = 0;
                while (offset < frame.Length)
                {
                    var sent = await socket
                        .SendAsync(new ArraySegment<byte>(frame, offset, frame.Length - offset), SocketFlags.None)
                        .ConfigureAwait(false);
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
                await SendFrame(socket, frame, _lifetime?.Token ?? CancellationToken.None)
                    .ConfigureAwait(false);
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

                await SendFrame(socket, frame, token).ConfigureAwait(false);

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
                // ConfigureAwait(false) here governs only the rest of *this* method - a caller
                // awaiting SendCommandAsync still resumes on whatever context it awaited from,
                // so user code is unaffected.
                await Connected.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return false;
            }

            if (await TrySendFrame(frame).ConfigureAwait(false))
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
