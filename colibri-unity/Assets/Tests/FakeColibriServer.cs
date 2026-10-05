using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// A stand-in for colibri-server that a test can script, for the connection behaviour a real
    /// server will not produce on demand: hanging up, saying nothing, or refusing this client.
    ///
    /// What happens to a connection is decided when it is accepted, by <see cref="Mode"/>, so a
    /// test walks the client through a sequence of sessions by changing it between attempts - the
    /// reconnect backoff leaves at least half a second for that. It speaks the v3 framing through
    /// the package's own <see cref="FrameCodec"/>, like <see cref="TcpPeer"/> does.
    /// </summary>
    public sealed class FakeColibriServer : IDisposable
    {
        public enum Behaviour
        {
            /// <summary>
            /// Reads the client's handshake and then hangs up cleanly, without a word. Waiting for
            /// the handshake keeps it deterministic: hanging up first races the client's write, and
            /// a session that ends before the handshake is sent is not a statement about the server.
            /// </summary>
            HangUpAfterHandshake,

            /// <summary>Accepts and keeps the connection open, but never sends a byte.</summary>
            Silent,

            /// <summary>What a live server looks like from the client: a heartbeat every 100 ms.</summary>
            Heartbeat,

            /// <summary>
            /// What a newer server does with this client: refuses its protocol version as the very
            /// first frame, then hangs up - the way colibri-server's <c>rejectProtocolVersion</c>
            /// does it, with the refusal and the FIN queued together.
            /// </summary>
            Refuse,
        }

        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly List<double> _acceptTimes = new List<double>();
        private readonly List<TcpClient> _open = new List<TcpClient>();
        private readonly List<(int Session, DecodedFrame Frame)> _received = new List<(int, DecodedFrame)>();
        private int _accepted;
        private volatile Behaviour _mode;

        public int Port { get; }

        /// <summary>Applies to the next connection accepted, not to the ones already open.</summary>
        public Behaviour Mode
        {
            get => _mode;
            set => _mode = value;
        }

        /// <summary>The protocol version a <see cref="Behaviour.Refuse"/> session says it speaks.</summary>
        public string RefusingServerVersion { get; set; } = "3";

        public int Accepted => Volatile.Read(ref _accepted);

        /// <summary>When each connection was accepted, in milliseconds since the server started.</summary>
        public double[] AcceptTimes
        {
            get
            {
                lock (_acceptTimes)
                    return _acceptTimes.ToArray();
            }
        }

        /// <summary>
        /// Every message frame a client sent, with the 1-based number of the connection it came on.
        /// Only recorded by <see cref="Behaviour.Heartbeat"/> sessions; heartbeat echoes are left out.
        /// </summary>
        public (int Session, DecodedFrame Frame)[] Received
        {
            get
            {
                lock (_received)
                    return _received.ToArray();
            }
        }

        private FakeColibriServer(TcpListener listener, Behaviour mode)
        {
            _listener = listener;
            _mode = mode;
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        }

        public static FakeColibriServer Start(Behaviour mode)
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();

            var server = new FakeColibriServer(listener, mode);
            _ = server.AcceptLoop();
            return server;
        }

        /// <summary>
        /// Resets every open connection (RST rather than FIN), which the client sees as a
        /// SocketException - the way a dropped Wi-Fi link or a killed server usually ends.
        /// </summary>
        public void ResetConnections()
        {
            TcpClient[] open;
            lock (_open)
            {
                open = _open.ToArray();
                _open.Clear();
            }

            foreach (var client in open)
            {
                try
                {
                    client.Client.LingerState = new LingerOption(true, 0);
                    client.Close();
                }
                catch (Exception)
                {
                    // Already gone, which is what was asked for.
                }
            }
        }

        public void Dispose()
        {
            _lifetime.Cancel();
            _listener.Stop();
            ResetConnections();
            _lifetime.Dispose();
        }


        /*
         *  Sessions
         */

        private async Task AcceptLoop()
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    return; // listener stopped
                }

                int session;
                lock (_acceptTimes)
                {
                    _acceptTimes.Add(_clock.Elapsed.TotalMilliseconds);
                    session = _acceptTimes.Count;
                }

                lock (_open)
                    _open.Add(client);

                Interlocked.Increment(ref _accepted);
                _ = Serve(client, session, _mode);
            }
        }

        private async Task Serve(TcpClient client, int session, Behaviour mode)
        {
            var token = _lifetime.Token;
            try
            {
                client.NoDelay = true;
                var stream = client.GetStream();

                switch (mode)
                {
                    case Behaviour.HangUpAfterHandshake:
                        await ReadHandshake(stream, token).ConfigureAwait(false);
                        await HangUp(client, stream, token).ConfigureAwait(false);
                        break;

                    case Behaviour.Silent:
                        await Drain(stream, token).ConfigureAwait(false);
                        break;

                    case Behaviour.Heartbeat:
                        var reading = Record(stream, session, token);
                        await Heartbeat(stream, token).ConfigureAwait(false);
                        await reading.ConfigureAwait(false);
                        break;

                    case Behaviour.Refuse:
                        var handshake = await ReadHandshake(stream, token).ConfigureAwait(false);
                        var refusal = FrameCodec.EncodeMessage("colibri", "protocol::rejected", Encoding.UTF8.GetBytes(
                            $"{{\"serverVersion\":\"{RefusingServerVersion}\",\"clientVersion\":\"{handshake?.Version}\","
                            + $"\"reason\":\"Unsupported protocol version {handshake?.Version}; this server speaks {RefusingServerVersion}\"}}"));
                        await stream.WriteAsync(refusal, 0, refusal.Length, token).ConfigureAwait(false);
                        await HangUp(client, stream, token).ConfigureAwait(false);
                        break;
                }
            }
            catch (Exception)
            {
                // The client went away, or the test is over; either way this session is done.
            }
            finally
            {
                lock (_open)
                    _open.Remove(client);
                client.Close();
            }
        }

        private static async Task<DecodedFrame?> ReadHandshake(NetworkStream stream, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[4096];
            while (true)
            {
                var read = await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
                if (read <= 0)
                    return null;

                foreach (var frame in Decode(reader, buffer, read))
                {
                    if (frame.Type == FrameType.Handshake)
                        return frame;
                }
            }
        }

        /// <summary>
        /// FIN first, then wait for the client to close its side. Closing outright with the client's
        /// bytes still unread would send an RST instead, and an RST can overtake data still in flight.
        /// </summary>
        private static async Task HangUp(TcpClient client, NetworkStream stream, CancellationToken token)
        {
            client.Client.Shutdown(SocketShutdown.Send);
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                timeout.CancelAfter(5000);
                await Drain(stream, timeout.Token).ConfigureAwait(false);
            }
        }

        private static async Task Drain(NetworkStream stream, CancellationToken token)
        {
            var buffer = new byte[4096];
            while (await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false) > 0)
            {
            }
        }

        private async Task Heartbeat(NetworkStream stream, CancellationToken token)
        {
            for (ulong beat = 1; !token.IsCancellationRequested; beat++)
            {
                var frame = FrameCodec.EncodeHeartbeat(beat);
                await stream.WriteAsync(frame, 0, frame.Length, token).ConfigureAwait(false);
                await Task.Delay(100, token).ConfigureAwait(false);
            }
        }

        private async Task Record(NetworkStream stream, int session, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var read = await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
                if (read <= 0)
                    return;

                foreach (var frame in Decode(reader, buffer, read))
                {
                    if (frame.Type != FrameType.Message)
                        continue;

                    lock (_received)
                        _received.Add((session, frame));
                }
            }
        }

        /// <summary>Out of the async methods because a ReadOnlySpan cannot live in one.</summary>
        private static List<DecodedFrame> Decode(FrameReader reader, byte[] buffer, int count)
            => new List<DecodedFrame>(reader.Append(new ReadOnlySpan<byte>(buffer, 0, count)));
    }
}
