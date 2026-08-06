using System.Collections;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The half of the version check the server cannot perform: noticing that the *server* is the
    /// one out of date.
    ///
    /// A pre-2.0.0 server has no version check, so it never refuses this client and never says
    /// what it speaks. Worse, its framing differs enough that it could not decode an explicit
    /// refusal even if one were sent. All that is left is the symptom - connections that are
    /// accepted and then die before a single frame can be read - which is what
    /// <see cref="WebServerConnection.SuspectedProtocolMismatch"/> reports on.
    ///
    /// These tests do not use <see cref="ColibriE2EFixture"/>: they have to point the connection
    /// singleton somewhere other than the real server, so they own its lifetime themselves and put
    /// it back afterwards.
    /// </summary>
    public class ProtocolMismatchDetectionTests
    {
        private FakeV1Server _fakeServer;

        [UnitySetUp]
        public IEnumerator ReplaceTheConnection()
        {
            E2EServer.RequireReachable();
            yield return DestroyConnection();
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            _fakeServer?.Dispose();
            _fakeServer = null;

            // Put the singleton back the way the rest of the suite expects to find it: pointed at
            // the real server and freshly built, so the next fixture's Instance does not hand back
            // a connection still trying to reach a listener this test has closed.
            yield return DestroyConnection();
            E2EServer.Configure();

            LogAssert.ignoreFailingMessages = false;
        }

        /// <summary>
        /// A real 1.x server heartbeats <c>"\0\0\0h\0"</c> at every client every 100 ms, handshaked
        /// or not, and does not hang up on a handshake it cannot parse. Read as v3 framing those
        /// five bytes declare a 1.74 GB frame - past the reader's 5 MB ceiling - so the reader
        /// throws on the first beat of every attempt, and no attempt ever decodes anything.
        /// </summary>
        [UnityTest]
        public IEnumerator AServerSpeakingV1FramingIsReportedAsASuspectedMismatch()
        {
            // Every attempt fails on purpose and logs a decode error as it goes ("Invalid frame
            // length: 1744830464" - the 1.74 GB those five bytes declare). Set here rather than in
            // [UnitySetUp], which the framework's own per-test reset lands after.
            IgnoreTheExpectedFailures();

            _fakeServer = FakeV1Server.Start();
            yield return PointConnectionAt(_fakeServer.Port);

            // Three attempts at 500/1000/2000 ms of backoff, plus room for a loaded batchmode
            // editor to get round to them.
            yield return E2EServer.WaitUntil(
                () => Connection.SuspectedProtocolMismatch != null,
                "The client never suspected a protocol mismatch against a server speaking v1 framing",
                20f);

            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain("protocol mismatch"));
            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain(WebServerConnection.ClientVersion));

            // A suspicion is not a finding: it reads the same as an address pointing at something
            // that is not colibri-server at all, so it must not become terminal.
            Assert.That(Connection.Status, Is.Not.EqualTo(ConnectionStatus.ProtocolMismatch),
                "A guess must not settle into the status reserved for a refusal the server actually sent");
            Assert.That(Connection.ProtocolMismatchReason, Is.Null,
                "ProtocolMismatchReason is for what the server said, and this server said nothing");
        }

        /// <summary>
        /// The counterpart, and the reason the hint is scoped to sessions that got past the
        /// handshake: a server that is simply not running fails every attempt without decoding a
        /// frame either, and blaming that on the protocol version would send people looking in
        /// entirely the wrong place.
        /// </summary>
        [UnityTest]
        public IEnumerator AServerThatIsNotRunningIsNotReportedAsAMismatch()
        {
            IgnoreTheExpectedFailures();

            yield return PointConnectionAt(FakeV1Server.FindClosedPort());

            // Comfortably past the three attempts the hint would need.
            yield return E2EServer.Settle(8f);

            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null,
                "'Connection refused' is a server that is switched off, not a version problem");
            Assert.That(Connection.Status, Is.Not.EqualTo(ConnectionStatus.Connected));
        }


        /*
         *  Driving the connection singleton
         */

        private static WebServerConnection Connection => WebServerConnection.Instance;

        /// <summary>
        /// Failing to connect is the subject of these tests, so the logs it produces are expected
        /// output rather than an unhandled error. Must be called from the test body: the framework
        /// resets this per test, after <c>[UnitySetUp]</c> has run.
        /// </summary>
        private static void IgnoreTheExpectedFailures() => LogAssert.ignoreFailingMessages = true;

        private static IEnumerator PointConnectionAt(int tcpPort)
        {
            E2EServer.Configure();
            var config = ColibriConfig.Load();
            config.TcpServerPort = tcpPort;

            // OnEnable is what reads the config, so the port only takes effect on a fresh
            // instance - which touching Instance after the teardown above creates.
            Assert.That(Connection, Is.Not.Null);
            yield return null;
        }

        private static IEnumerator DestroyConnection()
        {
            var existing = Object.FindFirstObjectByType<WebServerConnection>();
            if (existing != null)
            {
                // OnDisable cancels the loop and closes the socket; the frame after is what lets
                // the cancelled loop unwind before anything rebuilds it.
                Object.DestroyImmediate(existing.gameObject);
                yield return null;
            }
        }


        /// <summary>
        /// The 1.x wire behaviour that matters here, and nothing else: accept, then heartbeat
        /// <c>"\0\0\0h\0"</c> every 100 ms without ever reading what the client sent. A real 1.x
        /// server logs the unparseable handshake and keeps the connection open, which is what
        /// makes this detectable at all.
        /// </summary>
        private sealed class FakeV1Server : System.IDisposable
        {
            private static readonly byte[] V1Heartbeat = { 0, 0, 0, (byte)'h', 0 };

            private readonly TcpListener _listener;
            private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();

            public int Port { get; }

            private FakeV1Server(TcpListener listener, int port)
            {
                _listener = listener;
                Port = port;
            }

            public static FakeV1Server Start()
            {
                var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;

                var server = new FakeV1Server(listener, port);
                _ = server.AcceptLoop();
                return server;
            }

            /// <summary>A port nothing is listening on: bound to reserve it, then released.</summary>
            public static int FindClosedPort()
            {
                var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                listener.Stop();
                return port;
            }

            private async Task AcceptLoop()
            {
                while (!_lifetime.IsCancellationRequested)
                {
                    TcpClient client;
                    try
                    {
                        client = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                    }
                    catch
                    {
                        return; // listener stopped
                    }

                    _ = HeartbeatLoop(client);
                }
            }

            private async Task HeartbeatLoop(TcpClient client)
            {
                using (client)
                {
                    var stream = client.GetStream();
                    while (!_lifetime.IsCancellationRequested)
                    {
                        try
                        {
                            await stream.WriteAsync(V1Heartbeat, 0, V1Heartbeat.Length, _lifetime.Token)
                                .ConfigureAwait(false);
                            await Task.Delay(100, _lifetime.Token).ConfigureAwait(false);
                        }
                        catch
                        {
                            return; // the client dropped us, which is the expected ending
                        }
                    }
                }
            }

            public void Dispose()
            {
                _lifetime.Cancel();
                _listener.Stop();
                _lifetime.Dispose();
            }
        }
    }
}
