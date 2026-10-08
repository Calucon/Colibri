using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// A pass-through between the Unity client and the real server that a test can cut, for the
    /// outage a real network produces and a test cannot: the client loses its connection while the
    /// server, and every other client on the app, carries on. A C# port of the idea in
    /// <c>colibri-server/test/tcp-wire-tap.ts</c>.
    ///
    /// It also records every message the client sends, by connection, which is what lets a test
    /// see what went out on the session after a reconnect and in which order.
    /// </summary>
    public sealed class TcpProxy : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly string _upstreamHost;
        private readonly int _upstreamPort;
        private readonly bool _recordMessages;
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly List<TcpClient> _open = new List<TcpClient>();
        private readonly List<(int Session, DecodedFrame Frame)> _fromClient = new List<(int, DecodedFrame)>();
        private int _sessions;
        private volatile bool _isHolding;

        public int Port { get; }

        /// <summary>
        /// While set, a new connection is accepted but not passed on until this is cleared: the
        /// client's handshake waits in the socket, and nothing reaches it, so it stays reconnecting.
        /// Lets a test finish something on the server before the client is back - within the 2 s
        /// the client's watchdog gives a silent server.
        /// </summary>
        public bool HoldNewConnections
        {
            get => _isHolding;
            set => _isHolding = value;
        }

        /// <summary>How many connections the client has made through the proxy.</summary>
        public int Sessions => Volatile.Read(ref _sessions);

        /// <summary>Every message frame the client sent, with the 1-based connection it came on.</summary>
        public (int Session, DecodedFrame Frame)[] FromClient
        {
            get
            {
                lock (_fromClient)
                    return _fromClient.ToArray();
            }
        }

        private TcpProxy(TcpListener listener, string upstreamHost, int upstreamPort, bool recordMessages)
        {
            _listener = listener;
            _upstreamHost = upstreamHost;
            _upstreamPort = upstreamPort;
            _recordMessages = recordMessages;
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        }

        /// <param name="recordMessages">
        /// False for a TLS connection, whose bytes cannot be read here: they are passed on as they
        /// are, and <see cref="FromClient"/> stays empty.
        /// </param>
        public static TcpProxy Start(string upstreamHost, int upstreamPort, bool recordMessages = true)
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();

            var proxy = new TcpProxy(listener, upstreamHost, upstreamPort, recordMessages);
            _ = proxy.AcceptLoop();
            return proxy;
        }

        /// <summary>
        /// Resets both halves of every open connection. The client sees a connection reset, as
        /// from a dropped link; the server sees the client go, and keeps serving everyone else.
        /// </summary>
        public void Cut()
        {
            TcpClient[] open;
            lock (_open)
            {
                open = _open.ToArray();
                _open.Clear();
            }

            foreach (var client in open)
                Reset(client);
        }

        public void Dispose()
        {
            _lifetime.Cancel();
            _listener.Stop();
            Cut();
            _lifetime.Dispose();
        }

        private async Task AcceptLoop()
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient downstream;
                try
                {
                    downstream = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    return; // listener stopped
                }

                var session = Interlocked.Increment(ref _sessions);
                _ = Relay(downstream, session);
            }
        }

        private async Task Relay(TcpClient downstream, int session)
        {
            var upstream = new TcpClient { NoDelay = true };
            downstream.NoDelay = true;

            lock (_open)
            {
                _open.Add(downstream);
                _open.Add(upstream);
            }

            try
            {
                while (_isHolding)
                    await Task.Delay(10, _lifetime.Token).ConfigureAwait(false);

                await upstream.ConnectAsync(_upstreamHost, _upstreamPort).ConfigureAwait(false);

                var toServer = Pump(downstream.GetStream(), upstream.GetStream(), _recordMessages ? session : 0);
                var toClient = Pump(upstream.GetStream(), downstream.GetStream(), 0);

                // Either direction ending ends the session, as a broken link would.
                await Task.WhenAny(toServer, toClient).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Cut, or the server went away; the session is over either way.
            }
            finally
            {
                lock (_open)
                {
                    _open.Remove(downstream);
                    _open.Remove(upstream);
                }

                Reset(downstream);
                Reset(upstream);
            }
        }

        /// <param name="recordAs">The session to record decoded messages under, or 0 not to.</param>
        private async Task Pump(NetworkStream from, NetworkStream to, int recordAs)
        {
            var reader = recordAs > 0 ? new FrameReader() : null;
            var buffer = new byte[16 * 1024];

            while (true)
            {
                var read = await from.ReadAsync(buffer, 0, buffer.Length, _lifetime.Token).ConfigureAwait(false);
                if (read <= 0)
                    return;

                if (reader != null)
                    Record(reader, buffer, read, recordAs);

                await to.WriteAsync(buffer, 0, read, _lifetime.Token).ConfigureAwait(false);
            }
        }

        /// <summary>Out of the async method because a ReadOnlySpan cannot live in one.</summary>
        private void Record(FrameReader reader, byte[] buffer, int count, int session)
        {
            foreach (var frame in reader.Append(new ReadOnlySpan<byte>(buffer, 0, count)))
            {
                if (frame.Type != FrameType.Message)
                    continue;

                lock (_fromClient)
                    _fromClient.Add((session, frame));
            }
        }

        private static void Reset(TcpClient client)
        {
            try
            {
                client.Client.LingerState = new LingerOption(true, 0);
                client.Close();
            }
            catch (Exception)
            {
                // Already closed.
            }
        }
    }
}
