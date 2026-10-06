using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
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
        /// Protocol version announced in the handshake. Has to equal <c>PROTOCOL_VERSION</c> in
        /// the server's <c>src/server/modules/networking/protocol.ts</c> and in colibri-web's
        /// <c>src/Colibri.ts</c>; colibri-server's <c>npm run test:vectors</c> checks that all of
        /// them agree. A server speaking anything else refuses the connection with a
        /// <see cref="PROTOCOL_REJECTED_COMMAND"/> message.
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
        /// How long one attempt to open the TCP connection may take before it is given up and
        /// retried after the usual backoff. The socket has no timeout of its own: an address that
        /// nothing answers on - a server switched off on another subnet, a mistyped IP - used to
        /// hold the attempt in Connecting for the OS's own SYN timeout, about two minutes on
        /// Android, without a retry or a word in the log. On a local network a connection opens in
        /// milliseconds; 5 s still leaves room for two lost SYNs on bad Wi-Fi.
        /// </summary>
        private const int CONNECT_TIMEOUT_MS = 5000;

        /// <summary>
        /// How many broadcasts and other messages that are not model state may wait for the
        /// connection while it is down. This is a last-write-wins sync client: growing the queue
        /// without limit during a long outage would only buffer updates that are already
        /// superseded, so past this the oldest are dropped. Model messages are not dropped here; see
        /// "The outbox" below for why, and for what bounds them instead.
        /// </summary>
        private const int MAX_QUEUED_MESSAGES = 256;

        /// <summary>
        /// How many messages the outbox may hold in all, model state included - the backstop behind
        /// <see cref="MAX_QUEUED_MESSAGES"/>, which only counts what may be dropped. A model::request,
        /// a model::delete and a model::update that cannot be folded (one someone awaits, or one with
        /// something else about its object queued in between) are not counted there, so an outage in
        /// which objects keep being created and destroyed used to queue them without limit; so did a
        /// connection whose writes fall behind what is sent. Past this many the oldest messages that
        /// may be dropped go first, and only then the oldest model messages: a loss nothing repairs,
        /// but a bounded one.
        /// </summary>
        private const int MAX_OUTBOX_MESSAGES = 10000;

        /// <summary>
        /// How long the end of Play mode, or quitting the app, waits for what is still in the outbox
        /// to be written to the socket before it is closed. The app is closing, so the wait is
        /// short: on a working connection, writing what is queued then - the updates the send-rate
        /// limit was holding, flushed by SyncTicker - only hands a few frames to the operating
        /// system.
        /// </summary>
        private const int QUIT_DRAIN_TIMEOUT_MS = 100;

        /// <summary>
        /// ClientLogger (<c>client-logger.ts</c>) reads this channel's payload with
        /// <c>asString()</c>, so it is the one channel that ships raw text instead of JSON -
        /// quoting it would put stray quotes in the admin UI's log page.
        /// </summary>
        private const string LOG_CHANNEL = "log";

        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        public delegate void MessageAction(string channel, string command, JToken payload);
        public event MessageAction OnMessageReceived;

        /// <summary>
        /// Raised on the main thread once the server has started talking to this client - its
        /// first frame, not merely an accepted TCP connection. Something that accepts and then
        /// says nothing, or speaks a framing this client cannot read, never raises it.
        /// </summary>
        /// <remarks>
        /// Both events are raised from <c>Update</c>, once per connection and in the order things
        /// happened, so the last one raised always tells the truth: a connection that drops and
        /// comes back between two frames - a long frame during a Wi-Fi blip - raises
        /// <see cref="OnDisconnected"/> and then <see cref="OnConnected"/> in the next frame.
        /// Disabling or destroying this component raises what is still due there and then, from
        /// <c>OnDisable</c>, so a connection open at that moment ends with its
        /// <see cref="OnDisconnected"/> too. The one exception is the end of Play mode or of the
        /// app, which raises neither: the objects the handlers belong to may already be gone.
        /// </remarks>
        public event Action OnConnected;

        /// <summary>
        /// Raised on the main thread once for every <see cref="OnConnected"/>, after it, when that
        /// connection ends - dropped, timed out, refused by the server, or closed by disabling or
        /// destroying this component (see <see cref="OnConnected"/> for the one exception). An
        /// attempt that never got as far as Connected raises neither event. That includes a server
        /// that refuses this client in its very first frame: it is reported by
        /// <see cref="Status"/> becoming <see cref="ConnectionStatus.ProtocolMismatch"/> and by
        /// <see cref="Connected"/> being cancelled.
        /// </summary>
        public event Action OnDisconnected;

        // Instance, not static: static state survives Enter Play Mode with domain reload
        // disabled and would leave a second play session talking to a dead socket.
        //
        // volatile: written by the connection loop off the main thread, read by Update()'s
        // heartbeat watchdog and by OnDisable. The send path uses _outboxSocket instead.
        private volatile Socket _socket;
        private CancellationTokenSource _lifetime;
        private string _hostname = "";

        // Serializes every write to the socket - the outbox's messages and the receive loop's
        // heartbeat echoes. Concurrent writes used to interleave their bytes and corrupt the
        // framing for everything that followed.
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

        /// <remarks>Internal for the EditMode tests, which hold it to stand in for a slow write.</remarks>
        internal SemaphoreSlim SendLock => _sendLock;

        // Every outgoing message, in the order it was sent, until it has been written to a socket.
        // See "The outbox" below. Everything from here to _hasWarnedAboutRefusal is under _outboxLock:
        // senders on any thread, the drainer on the thread pool and the connection loop all touch it.
        private readonly LinkedList<Outgoing> _outbox = new LinkedList<Outgoing>();
        private readonly object _outboxLock = new object();

        // The socket of the session the outbox currently drains into, and that session's token.
        // Null while not connected, which is what makes a send wait in the outbox.
        private Socket _outboxSocket;
        private CancellationToken _outboxToken;

        // True while a DrainOutbox() is running. There is never more than one, which is what keeps
        // the messages in order.
        private bool _isDraining;

        // Reset on every connection, so a drop is reported once per outage.
        private bool _hasWarnedAboutDrops;
        private bool _hasWarnedAboutOutboxLimit;

        // Set when the server refuses this client's protocol version. Nothing will ever be sent
        // again, so a send completes at once, as dropped, instead of waiting in the outbox.
        private bool _isRefused;
        private bool _hasWarnedAboutRefusal;

        // Receive loop in, main thread out.
        private readonly ConcurrentQueue<InPacket> _queuedCommands = new ConcurrentQueue<InPacket>();
        private long _lastHeartbeatTime;

        // Main thread only: the OnMessageReceived delegate last delivered to, and its handlers.
        private MessageAction _deliveringTo;
        private Delegate[] _deliveringToList;

        // Both touched from the connection loop and from Update() via the Status setter, so
        // every access to them is under _statusLock.
        private int _connectAttempts;
        private int _connectedSessions;

        /// <summary>
        /// How many times this connection has become <see cref="ConnectionStatus.Connected"/> -
        /// so 2 or more in an <see cref="OnConnected"/> handler means it is a reconnect.
        /// </summary>
        internal int ConnectedSessions
        {
            get
            {
                lock (_statusLock)
                    return _connectedSessions;
            }
        }

        // Connection loop only.
        private bool _hasReportedMissingConfig;
        private string _reportedSanitizedApp;

        // ColibriConfig.Load() goes through Resources.Load, which is main-thread only, so the
        // connection loop reads this snapshot instead of the ScriptableObject.
        private volatile string _serverAddress;
        private volatile string _appName;
        private volatile int _tcpPort;

        // Gate that `await Connected` waits on, replacing the UniRx IObservable<bool> awaiter.
        // Only user code awaits it now - the send path queues in the outbox instead of waiting
        // here. Deliberately a TaskCompletionSource and not a UniTaskCompletionSource: any number
        // of callers may await it at once, and a UniTaskCompletionSource throws "can not await
        // twice" on the second pending awaiter.
        //
        // volatile because the gate is re-armed on the connection loop's thread while code on
        // any other thread may be reading it to await.
        private volatile TaskCompletionSource<bool> _connectedGate = NewGate();
        private volatile bool _isGateOpen;

        /// <summary>
        /// Completes when <see cref="Status"/> becomes <see cref="ConnectionStatus.Connected"/>,
        /// i.e. once the server has sent its first frame. While disconnected it is a fresh, pending
        /// task again. Cancelled when this component is disabled, and when the server refuses this
        /// client's protocol version: that is final, so awaiting it would otherwise never return.
        /// </summary>
        public Task Connected => _connectedGate.Task;

        private static TaskCompletionSource<bool> NewGate()
            => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        // OnConnected (true) and OnDisconnected (false) still to be raised on the main thread, in
        // the order the transitions happened: they are queued under _statusLock, by the Status
        // setter. They used to be two flags, raised connected-first, so a connection that dropped
        // and came back before the next Update raised OnConnected and then OnDisconnected, and
        // left user code believing it was disconnected while it was connected.
        private readonly ConcurrentQueue<bool> _connectionEvents = new ConcurrentQueue<bool>();

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
        // Only a session that ends *before* this is set counts towards the framing hint.
        private volatile bool _decodedAnyFrame;

        // Connection loop only (the receive loop is part of it), except for the test accessor.
        private int _consecutiveEarlyFrameFailures;
        private volatile string _suspectedProtocolMismatch;

        // Session-scoped: set once the TCP connection is up and this client has sent its
        // handshake. Without it, a session that never got that far - "connection refused" because
        // the server simply is not running - would count towards the framing hint and have this
        // client blaming a version mismatch for a server that is switched off.
        private volatile bool _reachedHandshake;

        // Session-scoped: set as soon as the TCP connection is accepted, cleared when the session
        // ends or the watchdog in Update() fires. Covers the stretch before the first frame too:
        // something that accepts the connection and then never says a word would otherwise hold a
        // session in Connecting forever, now that Connected waits for the server to speak.
        private volatile bool _isWatchdogArmed;

        // The setter is a read-modify-write over several fields, and the connection loop and
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

                    var wasConnected = _status == ConnectionStatus.Connected;
                    _status = value;

                    if (_status == ConnectionStatus.Connected)
                    {
                        _connectAttempts = 0;
                        _connectedSessions++;
                        _connectionEvents.Enqueue(true);
                        _isGateOpen = true;

                        // The gate is created with RunContinuationsAsynchronously, so no awaiting
                        // caller resumes inline here and none of them runs while holding the lock.
                        _connectedGate.TrySetResult(true);
                    }
                    else if (_isGateOpen)
                    {
                        // Re-arm the gate so that `await Connected` while disconnected waits for
                        // the next successful connection.
                        _isGateOpen = false;
                        _connectedGate = NewGate();
                    }

                    // Final: there will be no next connection to wait for.
                    if (_status == ConnectionStatus.ProtocolMismatch)
                        _connectedGate.TrySetCanceled();

                    // One OnDisconnected per OnConnected, whatever ended the connection - a
                    // refusal included. It used to be raised for every failed attempt, connected
                    // or not, and never for a refusal at all.
                    if (wasConnected)
                        _connectionEvents.Enqueue(false);
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

            // Enabling the component again is a deliberate retry, refusal or not.
            lock (_outboxLock)
            {
                _isRefused = false;
                _hasWarnedAboutRefusal = false;
            }

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
            // Play mode ending, or the app quitting: SyncTicker has just handed over what the
            // send-rate limit was holding, and on Mono and IL2CPP a socket write completes a moment
            // later on a worker thread. Closing the socket straight away could lose it. An ordinary
            // disable does not wait: whatever is queued stays queued for the next enable.
            if (SingletonLifetime.IsQuitting)
                WaitForOutboxToDrain(QUIT_DRAIN_TIMEOUT_MS);

            _lifetime?.Cancel();
            _lifetime?.Dispose();
            _lifetime = null;

            CloseSocket(_socket);
            _socket = null;

            // Whatever is still queued stays queued: re-enabling the component sends it.
            CloseOutbox();

            // In this order: leaving Connected re-arms the gate with a fresh task, and that is
            // the one an `await Connected` from now on would otherwise wait on forever - OnEnable
            // replaces it rather than completing it.
            Status = ConnectionStatus.Disconnected;
            _connectedGate.TrySetCanceled();

            // A disabled or destroyed component gets no Update to raise them from, so the
            // OnDisconnected of a connection open until now was never raised - or, after a
            // re-enable, raised late. Not at the end of Play mode or of the app: teardown has no
            // order, and a handler would as likely run on an object destroyed a moment ago.
            if (!SingletonLifetime.IsQuitting)
                RaiseConnectionEvents();
        }

        private void OnDestroy()
        {
            // Nothing will ever send these now, so nobody awaiting one should wait any longer.
            Outgoing[] abandoned;
            lock (_outboxLock)
                abandoned = TakeEverythingQueued();

            foreach (var message in abandoned)
                message.Sent?.TrySetResult(false);
        }

        private void Update()
        {
            RefreshConfig();
            TrackDeliveryRate();
            RaiseConnectionEvents();
            DeliverReceivedMessages();

            if (_isWatchdogArmed && MillisSinceLastHeartbeat() > HEARTBEAT_TIMEOUT_THRESHOLD_MS)
            {
                // Disarmed first so this does not re-fire every frame while the session unwinds.
                _isWatchdogArmed = false;

                if (Status == ConnectionStatus.Connected)
                {
                    Debug.Log("Colibri: no heartbeat from the server, dropping the connection");
                    // Anything sent from here on waits for the next connection rather than going
                    // to a socket that is about to be closed.
                    CloseOutbox();
                    Status = ConnectionStatus.Disconnected;
                }
                else
                {
                    Debug.Log($"Colibri: {_serverAddress}:{_tcpPort} accepted the connection but has not sent anything in "
                        + $"{HEARTBEAT_TIMEOUT_THRESHOLD_MS / 1000f:0.#} s, dropping it");
                }

                // Faults the receive loop into the reconnect backoff.
                CloseSocket(_socket);
            }
        }

        /// <summary>Raises OnConnected and OnDisconnected for every transition still due, in order.</summary>
        private void RaiseConnectionEvents()
        {
            while (_connectionEvents.TryDequeue(out var connected))
            {
                if (connected)
                    Raise(OnConnected, nameof(OnConnected));
                else
                    Raise(OnDisconnected, nameof(OnDisconnected));
            }
        }

        /// <summary>
        /// Calls each handler on its own. One that throws would otherwise skip the handlers after
        /// it - Sync's re-request of the models after a reconnect among them - and the rest of
        /// this frame's Update: the received messages and the heartbeat watchdog.
        /// </summary>
        private static void Raise(Action handlers, string eventName)
        {
            if (handlers == null)
                return;

            foreach (var handler in handlers.GetInvocationList())
            {
                try
                {
                    ((Action)handler)();
                }
                catch (Exception e)
                {
                    Debug.LogError($"Colibri: a handler of {eventName} threw an exception. The other handlers were still called.\n{e}");
                }
            }
        }

        /// <summary>
        /// Hands a received message to the main thread, where <see cref="Update"/> delivers it.
        /// </summary>
        /// <remarks>Called from the receive loop; internal so the EditMode tests can queue one too.</remarks>
        internal void EnqueueReceived(string channel, string command, JToken payload)
            => _queuedCommands.Enqueue(new InPacket { Channel = channel, Command = command, Payload = payload });

        /// <summary>
        /// Delivers everything received since the last frame. Handlers run on the main thread to
        /// keep threading issues out of user code, and one at a time: a handler that throws used to
        /// take the remaining handlers of that message down with it, and push every message queued
        /// behind it to the next frame.
        /// </summary>
        /// <remarks>Internal so the EditMode tests can drive it without a player loop.</remarks>
        internal void DeliverReceivedMessages()
        {
            while (_queuedCommands.TryDequeue(out var packet))
            {
                var handlers = OnMessageReceived;
                if (handlers == null)
                    continue;

                // A multicast delegate is immutable, so its invocation list only needs fetching
                // again when someone has subscribed or unsubscribed since.
                if (!ReferenceEquals(handlers, _deliveringTo))
                {
                    _deliveringTo = handlers;
                    _deliveringToList = handlers.GetInvocationList();
                }

                foreach (var handler in _deliveringToList)
                {
                    try
                    {
                        ((MessageAction)handler)(packet.Channel, packet.Command, packet.Payload);
                    }
                    catch (Exception e)
                    {
                        Debug.LogError($"Colibri: a handler of OnMessageReceived threw an exception while handling {packet.Command} "
                            + $"on channel '{packet.Channel}'. The other handlers still received the message.\n{e}");
                    }
                }
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

                // Whitespace counts as nothing, as in ColibriConfig.IsConfigured: an App Name of
                // spaces used to connect, into an app of its own that no other client is in,
                // while the setup and status windows said the project was not configured.
                if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(app))
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

                var handshakeApp = SanitizeHandshakeField(app);
                if (handshakeApp != app && handshakeApp != _reportedSanitizedApp)
                {
                    // Said rather than done quietly: only clients announcing the same app name
                    // see each other, and a web client configured with the original name will not.
                    _reportedSanitizedApp = handshakeApp;
                    Debug.LogWarning(
                        $"Colibri: the App Name '{app}' cannot be sent as it is - it may not contain '::' or start or end with ':'. " +
                        $"Connecting as '{handshakeApp}' instead; change the App Name if other clients use the original.");
                }

                var mismatched = false;

                try
                {
                    _decodedAnyFrame = false;
                    _reachedHandshake = false;
                    await RunSession(address, _tcpPort, handshakeApp, token)
                        .ConfigureAwait(false);
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
                }
                catch (TimeoutException e)
                {
                    // Nothing refused the connection - nothing answered at all, which is usually
                    // the wrong address, or a device on another network than the server.
                    Debug.Log($"Colibri: {e.Message}. Check the server address, and that this device is on the same network as the server. Retrying...");
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
                    _isWatchdogArmed = false;
                    CloseOutbox();
                    CloseSocket(_socket);
                    _socket = null;

                    // However the session ended - a clean hang-up, an undecodable frame, a reset,
                    // the watchdog - except for this component being disabled, which says nothing
                    // about the server.
                    if (!token.IsCancellationRequested)
                        CountSessionWithoutAFrame();

                    // Before the status changes, so nothing that reacts to ProtocolMismatch can
                    // still queue a message that would wait for a connection that never comes.
                    if (mismatched)
                        RefuseSends();

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
        ///
        /// Called once for every session that ends, whatever ended it. The count is reset by the
        /// first frame a session decodes (<see cref="OnFrameDecoded"/>), not here, so "consecutive"
        /// means what it says: it used to be updated only on a clean hang-up or an undecodable
        /// frame, and a session ended by a reset or the watchdog neither counted nor cleared it.
        /// </summary>
        private void CountSessionWithoutAFrame()
        {
            // Never got as far as a connected socket: that is a server that is down, a wrong
            // address or a closed port, and has nothing to say about protocol versions.
            if (!_reachedHandshake)
                return;

            if (_decodedAnyFrame)
                return;

            _consecutiveEarlyFrameFailures++;
            if (_consecutiveEarlyFrameFailures != EARLY_FRAME_FAILURES_BEFORE_HINT)
                return;

            _suspectedProtocolMismatch =
                $"{_consecutiveEarlyFrameFailures} connections in a row were accepted but ended before a single frame could be read. " +
                $"This usually means a protocol mismatch: this client speaks v{CLIENT_VERSION} and needs colibri-server >= 2.0.0.";

            Debug.LogError($"Colibri: {_suspectedProtocolMismatch} Check the server's version.");
        }

        /// <summary>
        /// The first frame of a session, of any kind - a refusal included - settles that this
        /// server speaks our framing, so it clears the count and the suspicion at once rather than
        /// whenever the session happens to end.
        /// </summary>
        private void OnFrameDecoded()
        {
            _decodedAnyFrame = true;
            _consecutiveEarlyFrameFailures = 0;
            _suspectedProtocolMismatch = null;
        }

        /// <summary>
        /// How many sessions in a row got past the handshake and then ended without a frame.
        /// Exists for the test suite; nothing in the library reads it.
        /// </summary>
        internal int ConsecutiveEarlyFrameFailures => Volatile.Read(ref _consecutiveEarlyFrameFailures);

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
                try
                {
                    await ConnectAsync(socket, host, port, CONNECT_TIMEOUT_MS, token).ConfigureAwait(false);
                }
                catch (TimeoutException e)
                {
                    _lastConnectFailure = e.Message;
                    throw;
                }
                catch (SocketException e) when (!token.IsCancellationRequested)
                {
                    _lastConnectFailure = $"connecting to {host}:{port} failed ({e.SocketErrorCode})";
                    throw;
                }

                token.ThrowIfCancellationRequested();
                _lastConnectFailure = null;

                // Accepted, but nothing is known about what accepted it yet. The watchdog gives
                // it as long to say something as a connected server gets between heartbeats.
                StampLiveness();
                _isWatchdogArmed = true;

                await SendFrame(socket, FrameCodec.EncodeHandshake(CLIENT_VERSION, app, _hostname), token)
                    .ConfigureAwait(false);
                // Past this point the connection was accepted and this client has spoken, so a
                // session that now ends without a frame is a statement about the server.
                _reachedHandshake = true;

                await ReceiveLoop(socket, host, port, app, token).ConfigureAwait(false);
            }
        }

        /// <summary>
        /// Opens the TCP connection, or gives up after <paramref name="timeoutMs"/>. Closing the
        /// socket is the only way to abandon a pending connect on this API surface, so that is
        /// what giving up does; the socket cannot be used again afterwards.
        /// </summary>
        /// <exception cref="TimeoutException">Nothing answered in time.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="SocketException">The attempt failed before the time was up - refused, say.</exception>
        /// <remarks>Internal for the EditMode tests, which time it against a port that never answers.</remarks>
        internal static async Task ConnectAsync(Socket socket, string host, int port, int timeoutMs, CancellationToken token)
        {
            var connecting = socket.ConnectAsync(host, port);

            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                if (await Task.WhenAny(connecting, Task.Delay(timeoutMs, timer.Token)).ConfigureAwait(false) == connecting)
                {
                    timer.Cancel();

                    // Rethrows a connect that failed by itself.
                    await connecting.ConfigureAwait(false);
                    return;
                }
            }

            CloseSocket(socket);

            // The abandoned connect now fails with the closed socket. Nothing is waiting for it any
            // more, so its exception is observed here rather than surfacing as unobserved later.
            _ = connecting.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            // Invariant: this ends up in the log and on screen, and "0,5 s" in one locale and
            // "0.5 s" in another is one more thing to puzzle over.
            throw new TimeoutException(
                $"{host}:{port} did not answer within {(timeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        /// <summary>
        /// The session is <see cref="ConnectionStatus.Connected"/> from the first frame the server
        /// sends, not from the moment the TCP connection opened. Anything can accept a connection:
        /// a 1.x server does, and then speaks a framing this client cannot read; so does a port
        /// that is not Colibri at all. Counting those as connections reset the reconnect backoff on
        /// every attempt - it never grew past 500 ms - and fired OnConnected, and flushed the queued
        /// messages, into a session that was about to fail. A server that says nothing at all is
        /// dropped by the watchdog in <see cref="Update"/>; the server heartbeats every 100 ms, so
        /// a real one is never kept waiting.
        /// </summary>
        private void BecomeConnected(Socket socket, string host, int port, string app, CancellationToken token)
        {
            StampLiveness();

            // The app name is named explicitly: a typo in it produces a perfectly healthy
            // connection on which no other client is ever seen.
            Debug.Log($"Colibri: connected to {host}:{port} as app '{app}'. Only clients using the same App Name can see each other.");

            // Starts sending whatever queued up during the outage, in order. Opened before Status
            // says Connected, so anything sent by code that reacts to Connected lines up behind it.
            OpenOutbox(socket, token);
            Status = ConnectionStatus.Connected;
        }

        private async Task ReceiveLoop(Socket socket, string host, int port, string app, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[RECEIVE_BUFFER_SIZE];
            var isConnected = false;

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

                // Once the server has proven itself, any received byte is proof of life: it
                // heartbeats every 100 ms whether or not there is traffic, and a large message can
                // take longer than that to arrive. Before then only a decoded frame counts, or
                // something trickling bytes that never form one would hold the session open.
                if (isConnected)
                    StampLiveness();

                var frames = ReadFrames(reader, buffer, received);
                if (frames.Count > 0 && !_decodedAnyFrame)
                    OnFrameDecoded();

                for (var i = 0; i < frames.Count; i++)
                {
                    var frame = frames[i];

                    // Checked before the session counts as connected: colibri-server says nothing
                    // to a client before it has accepted the handshake, so a refusal is the very
                    // first frame, and that must not first be reported as a connection. (A server
                    // that heartbeats first, as colibri-server once did, is refused all the same:
                    // the refusal then ends a session that counted as connected.)
                    if (frame.Type == FrameType.Message && frame.Channel == COLIBRI_CHANNEL && frame.Command == PROTOCOL_REJECTED_COMMAND)
                        throw BuildProtocolMismatch(frame.Payload);

                    if (!isConnected)
                    {
                        isConnected = true;
                        BecomeConnected(socket, host, port, app, token);
                    }

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
                            // A refusal never gets here - it is intercepted above, before the
                            // queue: it is Colibri's own plumbing, and delivering it as an ordinary
                            // message would leave every application to recognize it for itself.
                            // It throws, so the session unwinds through the one place that decides
                            // whether to retry.
                            EnqueueReceived(frame.Channel, frame.Command, ParsePayload(frame.Payload));
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

        /// <summary>
        /// Why the last attempt to open the TCP connection failed - "192.168.0.10:9012 did not
        /// answer within 5 s", say, or a refusal - or null once one has opened. For showing why the
        /// client is still not connected; each failure is logged as well. Unaffected by anything
        /// that happens after the connection opened.
        /// </summary>
        public string LastConnectFailure => _lastConnectFailure;
        private volatile string _lastConnectFailure;


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

        /*
         *  The outbox.
         *
         *  Every message goes into one FIFO and is written to the socket by one drainer, so they
         *  leave in exactly the order they were sent - across an outage too. Sends used to wait
         *  on the Connected gate instead: each one issued while disconnected parked a task (no
         *  bound), and on reconnect the parked continuations resumed together on the thread pool
         *  and raced for the socket, so outage messages went out in any order and interleaved with
         *  new ones. On a last-write-wins server that let a stale position overwrite a newer one.
         *
         *  While connected the outbox is just the way to the socket and is normally empty or
         *  close to it. While not, it is the retry queue, sent ahead of anything newer as soon as
         *  the next session is connected. A message whose write failed stays at the head and goes
         *  first next time.
         *
         *  The queue is bounded during an outage, but not by dropping just anything. Broadcasts -
         *  and anything else that is not model state - are capped at MAX_QUEUED_MESSAGES, oldest
         *  dropped first. The model commands are not dropped by it, because nothing would repair
         *  the loss: a dropped model::request leaves its SyncBehaviour waiting for its first state
         *  and never sending a change, a dropped model::delete leaves the object alive on every
         *  other client, and a dropped model::update - an object that changed once early in the
         *  outage while others kept moving - is lost, and the re-request after reconnecting then
         *  even reverts it locally to the server's older copy. Instead, every model::update queued
         *  for the same object during an outage is folded into one, newer fields winning, which
         *  is exactly what a last-write-wins server would have ended up with. That keeps model
         *  state bounded by the number of objects rather than by how long the outage lasts.
         *
         *  Requests, deletes and awaited updates are not folded, though; each is queued as it is.
         *  So behind both of these sits a hard cap on the whole outbox, MAX_OUTBOX_MESSAGES, which
         *  applies while connected too: the last resort, which does drop model state rather than
         *  grow without end.
         *
         *  The folded update moves to the back of the queue, so a fold must never carry an update
         *  past something else about the same object: a newer update, a delete, or a request the
         *  server would answer without it. Such a message ends the fold for that object, and the
         *  next update starts a new one behind it; reconnecting ends every fold.
         */

        private const string MODEL_REQUEST_COMMAND = "model::request";
        private const string MODEL_UPDATE_COMMAND = "model::update";
        private const string MODEL_DELETE_COMMAND = "model::delete";

        private sealed class Outgoing
        {
            public byte[] Frame;

            // Null for SendCommand, which nobody awaits.
            public TaskCompletionSource<bool> Sent;

            // Whether the outage bound counts it, and the cap on the whole outbox drops it before any
            // model command: false for the model commands.
            public bool CanDrop;

            // Set for a model::update queued during an outage, which later updates for the same
            // object in that outage may be folded into (see _queuedModelUpdates). The payload is a
            // private copy.
            public JObject ModelUpdate;
            public (string Channel, string Id) ModelKey;
        }

        // Under _outboxLock: how many droppable messages the outbox holds, and the model::update
        // queued for each object during the current outage that later ones can still be folded
        // into - one that nothing else about the object has been queued behind.
        private int _droppableCount;
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>> _queuedModelUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>>();

        /// <summary>Lets the outbox drain into this session. Called once it is Connected.</summary>
        /// <remarks>Internal for the EditMode tests, which open and close it around sessions they fake.</remarks>
        internal void OpenOutbox(Socket socket, CancellationToken token)
        {
            bool startDraining;
            lock (_outboxLock)
            {
                _outboxSocket = socket;
                _outboxToken = token;
                _hasWarnedAboutDrops = false;
                _hasWarnedAboutOutboxLimit = false;

                // Updates are only folded within one outage. From here on, those folded during the
                // outage that just ended are ordinary queued messages: what is sent while connected
                // lines up behind them without being looked at. If one is still queued when the
                // connection drops again - a slow link - folding the next outage's update for that
                // object into it would move it past those, a newer update to the object among them.
                _queuedModelUpdates.Clear();

                startDraining = !_isDraining && _outbox.Count > 0;
                if (startDraining)
                    _isDraining = true;
            }

            if (startDraining)
                _ = DrainOutbox();
        }

        /// <summary>Makes every send from now on wait in the outbox for the next connection.</summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal void CloseOutbox()
        {
            lock (_outboxLock)
            {
                _outboxSocket = null;
                _outboxToken = CancellationToken.None;

                // Nothing more will be written to that session: see WaitForOutboxToDrain.
                Monitor.PulseAll(_outboxLock);
            }
        }

        /// <summary>
        /// Blocks until everything in the outbox has been written to the current session's socket,
        /// the session has ended, or <paramref name="timeoutMs"/> has passed - whichever comes
        /// first. Returns at once while not connected.
        /// </summary>
        /// <returns>True if the outbox is empty.</returns>
        /// <remarks>
        /// Safe to call from the main thread: the drainer never needs it, since every await on the
        /// way to the socket is ConfigureAwait(false).
        /// </remarks>
        private bool WaitForOutboxToDrain(int timeoutMs)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            lock (_outboxLock)
            {
                // Woken by the drainer after each message it has written, and when the session ends.
                while (_outbox.Count > 0 && _outboxSocket != null)
                {
                    var remaining = timeoutMs - clock.ElapsedMilliseconds;
                    if (remaining <= 0)
                        break;

                    Monitor.Wait(_outboxLock, (int)remaining);
                }

                return _outbox.Count == 0;
            }
        }

        /// <summary>
        /// The server refused this client: everything still queued is dropped, and every send from
        /// now on is dropped as it is made. Waiting would be waiting forever - nothing will ever
        /// connect again - and that is a task leaked per send, plus RemoteLogging's queue growing
        /// for good behind a send that never returns.
        /// </summary>
        private void RefuseSends()
        {
            Outgoing[] dropped;
            lock (_outboxLock)
            {
                _isRefused = true;
                dropped = TakeEverythingQueued();
            }

            foreach (var message in dropped)
                message.Sent?.TrySetResult(false);
        }

        // Under _outboxLock.
        private Outgoing[] TakeEverythingQueued()
        {
            var taken = new Outgoing[_outbox.Count];
            _outbox.CopyTo(taken, 0);
            _outbox.Clear();
            _queuedModelUpdates.Clear();
            _droppableCount = 0;
            return taken;
        }

        // Under _outboxLock. Every removal from the outbox goes through here, so the count and the
        // index of queued model updates stay true to what is in it.
        private void RemoveFromOutbox(LinkedListNode<Outgoing> node)
        {
            _outbox.Remove(node);

            var message = node.Value;
            if (message.CanDrop)
                _droppableCount--;

            if (message.ModelUpdate != null
                && _queuedModelUpdates.TryGetValue(message.ModelKey, out var indexed)
                && ReferenceEquals(indexed, node))
            {
                _queuedModelUpdates.Remove(message.ModelKey);
            }
        }

        private void Post(string channel, string command, JToken payload, byte[] frame, TaskCompletionSource<bool> sent)
        {
            List<Outgoing> dropped = null;
            var warnAboutDrops = false;
            var warnAboutOutboxLimit = false;
            var startDraining = false;
            var refused = false;
            var warnAboutRefusal = false;

            lock (_outboxLock)
            {
                if (_isRefused)
                {
                    refused = true;
                    warnAboutRefusal = !_hasWarnedAboutRefusal;
                    _hasWarnedAboutRefusal = true;
                }
                else if (_outboxSocket == null)
                {
                    Queue(channel, command, payload, frame, sent);

                    while (_droppableCount > MAX_QUEUED_MESSAGES)
                    {
                        var oldest = _outbox.First;
                        while (!oldest.Value.CanDrop)
                            oldest = oldest.Next;

                        (dropped ??= new List<Outgoing>()).Add(oldest.Value);
                        RemoveFromOutbox(oldest);
                    }

                    if (dropped != null && !_hasWarnedAboutDrops)
                    {
                        _hasWarnedAboutDrops = true;
                        warnAboutDrops = true;
                    }
                }
                else
                {
                    _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = IsDroppable(command) });
                    if (IsDroppable(command))
                        _droppableCount++;

                    if (!_isDraining)
                    {
                        _isDraining = true;
                        startDraining = true;
                    }
                }

                if (!refused && _outbox.Count > MAX_OUTBOX_MESSAGES)
                {
                    EnforceOutboxLimit(ref dropped);

                    warnAboutOutboxLimit = !_hasWarnedAboutOutboxLimit;
                    _hasWarnedAboutOutboxLimit = true;
                }
            }

            // Logged, and the dropped tasks completed, outside the lock: both can run other code.
            if (refused)
            {
                if (warnAboutRefusal)
                {
                    Debug.LogWarning($"Colibri: not sending {command} on channel '{channel}' - the server refused this client's protocol version, "
                        + "so nothing is sent any more. Every later message is dropped the same way; this is said once.");
                }

                sent?.TrySetResult(false);
                return;
            }

            if (warnAboutDrops)
            {
                Debug.LogWarning($"Colibri: more than {MAX_QUEUED_MESSAGES} messages are waiting for the connection to come back, "
                    + "so the oldest are being dropped. Synchronized model state is kept: it is folded into one update per object instead. "
                    + "Said once per outage.");
            }

            if (warnAboutOutboxLimit)
            {
                Debug.LogWarning($"Colibri: more than {MAX_OUTBOX_MESSAGES} messages are waiting to be sent, so the oldest are being dropped - "
                    + "broadcasts and other messages first, and once there are none of those left, synchronized model state (requests, "
                    + "updates and deletes), which other clients then never see. Said once per connection.");
            }

            if (dropped != null)
            {
                foreach (var message in dropped)
                    message.Sent?.TrySetResult(false);
            }

            // Outside the lock: the drain runs synchronously up to its first write that does not
            // complete at once.
            if (startDraining)
                _ = DrainOutbox();
        }

        // Under _outboxLock. The oldest message that may be dropped goes first, and only when none
        // is left the oldest of the rest. Never the message the drainer is writing at this moment:
        // dropping that one would report as dropped a message that may well arrive.
        private void EnforceOutboxLimit(ref List<Outgoing> dropped)
        {
            while (_outbox.Count > MAX_OUTBOX_MESSAGES)
            {
                var oldest = _isDraining ? _outbox.First.Next : _outbox.First;

                var victim = oldest;
                if (_droppableCount > 0)
                {
                    var droppable = oldest;
                    while (droppable != null && !droppable.Value.CanDrop)
                        droppable = droppable.Next;

                    victim = droppable ?? oldest;
                }

                (dropped ??= new List<Outgoing>()).Add(victim.Value);
                RemoveFromOutbox(victim);
            }
        }

        // Under _outboxLock, while not connected.
        private void Queue(string channel, string command, JToken payload, byte[] frame, TaskCompletionSource<bool> sent)
        {
            // Only what nobody awaits is folded: each awaited task has to complete for its own message.
            if (sent == null && command == MODEL_UPDATE_COMMAND && TryGetModelId(payload, out var update, out var id))
            {
                var key = (channel, id);

                // A copy, because the caller's object may change after it was sent.
                var latest = (JObject)update.DeepClone();

                if (_queuedModelUpdates.TryGetValue(key, out var queued))
                {
                    var merged = (JObject)queued.Value.ModelUpdate.DeepClone();
                    foreach (var property in latest.Properties())
                        merged[property.Name] = property.Value;

                    var mergedFrame = TryEncodeFrame(channel, command, merged);
                    if (mergedFrame != null)
                    {
                        // To the back of the queue: it now carries the newest change.
                        RemoveFromOutbox(queued);
                        latest = merged;
                        frame = mergedFrame;
                    }
                }

                _queuedModelUpdates[key] = _outbox.AddLast(new Outgoing { Frame = frame, CanDrop = false, ModelUpdate = latest, ModelKey = key });
                return;
            }

            var canDrop = IsDroppable(command);
            if (!canDrop)
                StopFolding(channel, payload);

            _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = canDrop });
            if (canDrop)
                _droppableCount++;
        }

        // Under _outboxLock, for a model command that is not folded: an update someone awaits, a
        // request or a delete. A folded update goes to the back of the queue, so the update queued
        // for an object may only absorb later ones while nothing else about that object is queued
        // behind it. Otherwise its older values would overtake a newer update, arrive after a
        // delete and bring the object back, or miss a request the server then answers without them.
        private void StopFolding(string channel, JToken payload)
        {
            if (TryGetModelId(payload, out _, out var id))
            {
                _queuedModelUpdates.Remove((channel, id));
                return;
            }

            // No id: a request for the whole channel, which is about every object on it. (A
            // malformed update or delete ends up here too; ending more folds than needed only
            // costs queue space.)
            List<(string Channel, string Id)> onChannel = null;
            foreach (var key in _queuedModelUpdates.Keys)
            {
                if (key.Channel == channel)
                    (onChannel ??= new List<(string Channel, string Id)>()).Add(key);
            }

            if (onChannel != null)
            {
                foreach (var key in onChannel)
                    _queuedModelUpdates.Remove(key);
            }
        }

        private static bool IsDroppable(string command)
            => command != MODEL_REQUEST_COMMAND && command != MODEL_UPDATE_COMMAND && command != MODEL_DELETE_COMMAND;

        private static bool TryGetModelId(JToken payload, out JObject update, out string id)
        {
            update = payload as JObject;
            id = null;

            if (update == null || !(update["id"] is JValue value) || value.Type != JTokenType.String)
                return false;

            id = (string)value;
            return true;
        }

        /// <summary>
        /// Writes the outbox to the current session's socket, head first, until it is empty or
        /// the session is gone. Only ever one running (<c>_isDraining</c>), and it reads the session
        /// afresh for every message, so a drainer that outlives one session carries on into the next.
        /// </summary>
        private async Task DrainOutbox()
        {
            while (true)
            {
                LinkedListNode<Outgoing> node;
                Outgoing next;
                Socket socket;
                CancellationToken token;
                lock (_outboxLock)
                {
                    if (_outboxSocket == null || _outbox.Count == 0)
                    {
                        _isDraining = false;
                        return;
                    }

                    node = _outbox.First;
                    next = node.Value;
                    socket = _outboxSocket;
                    token = _outboxToken;
                }

                try
                {
                    await SendFrame(socket, next.Frame, token).ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    // The message stays at the head of the outbox and is the first thing the
                    // next session sends. This session is finished: close it, so the receive loop
                    // notices now rather than at the next heartbeat.
                    lock (_outboxLock)
                    {
                        if (ReferenceEquals(_outboxSocket, socket))
                        {
                            _outboxSocket = null;
                            _outboxToken = CancellationToken.None;
                            Monitor.PulseAll(_outboxLock);
                        }
                    }

                    if (!token.IsCancellationRequested)
                        Debug.Log($"Colibri: sending failed ({e.GetType().Name}: {e.Message}); queued messages will be sent after reconnecting");

                    CloseSocket(socket);
                    continue;
                }

                lock (_outboxLock)
                {
                    // Gone already if, while it was being written, the session ended and the
                    // outage bound dropped it. (A fold never absorbs it: only updates queued since
                    // the outbox last closed are folded into, and this one was queued before that.)
                    if (node.List == _outbox)
                        RemoveFromOutbox(node);

                    // One message further: see WaitForOutboxToDrain.
                    Monitor.PulseAll(_outboxLock);
                }

                next.Sent?.TrySetResult(true);
            }
        }

        private static byte[] EncodeFrame(string channel, string command, JToken payload)
        {
            try
            {
                return FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException e)
            {
                // One unrepresentable message is dropped as one bad message, exactly as the
                // server does on its own egress path.
                Debug.LogError($"Colibri: dropping unencodable message ({channel} / {command}): {e.Message}");
                return null;
            }
        }

        private static byte[] TryEncodeFrame(string channel, string command, JToken payload)
        {
            try
            {
                return FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException)
            {
                return null;
            }
        }

        /// <summary>
        /// Sends a message, queueing it while not connected.
        /// </summary>
        /// <returns>
        /// Completes with true once the message has been written to the socket, or with false if
        /// it never will be: it could not be encoded, a bound on the outbox dropped it, the server
        /// refused this client's protocol version, or this component was destroyed first. Never
        /// false for a message that is still going to be sent, so there is nothing to retry. While
        /// the connection is down it stays pending.
        /// </returns>
        public Task<bool> SendCommandAsync(string channel, string command, JToken payload)
        {
            var frame = EncodeFrame(channel, command, payload);
            if (frame == null)
                return Task.FromResult(false);

            // RunContinuationsAsynchronously: it is completed by the drainer and from under the
            // outbox's callers, neither of which should run the awaiting code inline.
            var sent = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            Post(channel, command, payload, frame, sent);
            return sent.Task;
        }

        /// <summary>Sends a message, queueing it while not connected. See <see cref="SendCommandAsync"/>.</summary>
        public void SendCommand(string channel, string command, JToken payload)
        {
            var frame = EncodeFrame(channel, command, payload);
            if (frame != null)
                Post(channel, command, payload, frame, null);
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

        /// <summary>
        /// Makes a device or app name safe to put in the handshake. '::' is the field separator,
        /// so a name containing one produces a frame the server rejects outright. A single ':' at
        /// either end is worse, because nothing rejects it: it merges with the separator next to
        /// it into ':::', which the server splits as '::' + ':', so app "app:" arrives as app
        /// "app" with the colon moved onto the client name - another app, silently.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static string SanitizeHandshakeField(string value)
        {
            if (string.IsNullOrEmpty(value))
                return value;

            // After this there is no '::' left, so at most one ':' can remain at each end.
            var sanitized = value.Replace(FrameCodec.FieldSeparator, "_");

            if (sanitized[0] == ':')
                sanitized = "_" + sanitized.Substring(1);
            if (sanitized[sanitized.Length - 1] == ':')
                sanitized = sanitized.Substring(0, sanitized.Length - 1) + "_";

            return sanitized;
        }
    }
}
