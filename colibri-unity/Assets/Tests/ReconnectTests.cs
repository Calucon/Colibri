using System.Collections;
using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The connection dropping mid-session and coming back, against the real server - the Wi-Fi
    /// blip every headset in a study will have.
    ///
    /// The Unity client talks to the server through a <see cref="TcpProxy"/> that the test can
    /// cut, while the raw peer stays connected directly, as the rest of a session's clients would.
    /// Like <see cref="ProtocolMismatchDetectionTests"/>, these point the connection singleton
    /// somewhere other than the real server, so they own its lifetime and put it back afterwards.
    /// </summary>
    public class ReconnectTests
    {
        private TcpProxy _proxy;
        private TcpPeer _peer;

        private static WebServerConnection Connection => WebServerConnection.Instance;

        [UnitySetUp]
        public IEnumerator ConnectThroughAProxy()
        {
            E2EServer.RequireReachable();
            yield return DestroyConnection();

            _proxy = TcpProxy.Start(E2EServer.Host, E2EServer.TcpPort);

            E2EServer.Configure();
            ColibriConfig.Load().TcpServerPort = _proxy.Port;

            // OnEnable is what reads the config, so the port only takes effect on a fresh
            // instance - which touching Instance after the teardown above creates.
            Assert.That(Connection, Is.Not.Null);
            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The Unity client never connected through the proxy", 20f);

            _peer = new TcpPeer();
            yield return _peer.Connect("reconnect-peer");

            // The peer's handshake and a test's first message travel on different connections.
            yield return E2EServer.Settle(0.3f);
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            _peer?.Dispose();
            _peer = null;
            _proxy?.Dispose();
            _proxy = null;

            yield return DestroyConnection();
            E2EServer.Configure();
        }


        /*
         *  Messages sent while the connection is down
         */

        /// <summary>
        /// Sends issued during an outage used to each park on the Connected gate, and on reconnect
        /// the parked continuations resumed together on the thread pool and raced for the socket:
        /// outage messages went out in any order, interleaved with the ones sent after reconnecting.
        /// On a last-write-wins server that is a stale position overwriting a newer one. They now
        /// wait in one queue and go out in order, ahead of anything sent later.
        /// </summary>
        [UnityTest]
        public IEnumerator MessagesSentDuringAnOutageArriveInOrderAheadOfNewerOnes()
        {
            var channel = E2EServer.Channel("outage-order");
            var next = 1;

            for (var i = 0; i < 5; i++)
                Sync.Send(channel, next++);
            yield return E2EServer.WaitUntil(() => Received(channel).Length == 5,
                "The messages sent before the outage never arrived");

            yield return CutTheConnection();

            for (var i = 0; i < 30; i++)
                Sync.Send(channel, next++);

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The client never reconnected after the outage", 20f);

            // The moment it is back, while the outage's messages may well still be going out.
            for (var i = 0; i < 30; i++)
                Sync.Send(channel, next++);

            var expected = Enumerable.Range(1, next - 1).ToArray();
            yield return E2EServer.WaitUntil(() => Received(channel).Length >= expected.Length,
                $"Only {Received(channel).Length} of the {expected.Length} messages arrived");
            yield return E2EServer.Settle(0.3f);

            Assert.That(Received(channel), Is.EqualTo(expected),
                "Messages arrived out of order, or twice, across the outage");
        }

        /// <summary>
        /// The queue that holds an outage's messages is bounded, so a long outage costs the oldest
        /// of them rather than unbounded memory - and says so, once. What is kept still arrives in
        /// order.
        /// </summary>
        [UnityTest]
        public IEnumerator ALongOutageKeepsTheNewestMessagesAndSaysSoOnce()
        {
            const int sent = 300;
            const int kept = 256;
            var channel = E2EServer.Channel("outage-bound");

            yield return CutTheConnection();

            var warnings = 0;
            Application.LogCallback countWarnings = (message, stackTrace, type) =>
            {
                if (type == LogType.Warning && Regex.IsMatch(message, $"^Colibri: more than {kept} messages are waiting for the connection to come back"))
                    System.Threading.Interlocked.Increment(ref warnings);
            };

            Application.logMessageReceivedThreaded += countWarnings;
            try
            {
                for (var i = 1; i <= sent; i++)
                    Sync.Send(channel, i);

                yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                    "The client never reconnected after the outage", 20f);

                var expected = Enumerable.Range(sent - kept + 1, kept).ToArray();
                yield return E2EServer.WaitUntil(() => Received(channel).Length >= expected.Length,
                    $"Only {Received(channel).Length} of the {expected.Length} queued messages arrived");
                yield return E2EServer.Settle(0.3f);

                Assert.That(Received(channel), Is.EqualTo(expected),
                    "The queue should keep exactly the newest messages, in order");
                Assert.That(warnings, Is.EqualTo(1), "Dropping the oldest messages should be said exactly once per outage");
            }
            finally
            {
                Application.logMessageReceivedThreaded -= countWarnings;
            }
        }


        /*
         *  Helpers
         */

        /// <summary>Cuts the link and waits until the client has noticed, so what follows is sent during the outage.</summary>
        private IEnumerator CutTheConnection()
        {
            var sessions = _proxy.Sessions;
            _proxy.Cut();

            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection was cut");

            // Still the session that was cut: the reconnect is at least 500 ms of backoff away.
            Assert.That(_proxy.Sessions, Is.EqualTo(sessions));
        }

        private int[] Received(string channel)
            => _peer.Received
                .Where(f => f.Channel == channel)
                .Select(f => int.Parse(TcpPeer.Text(f)))
                .ToArray();

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
    }
}
