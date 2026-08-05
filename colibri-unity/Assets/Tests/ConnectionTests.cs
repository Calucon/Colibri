using System;
using System.Collections;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The connection itself: the handshake, the heartbeat and the fact that the two ends can see
    /// each other at all. None of this was ever covered automatically - colibri-unity 2.0.0 spoke
    /// the v3 protocol for months on the strength of unit-tested framing and one manual session.
    /// </summary>
    public class ConnectionTests : ColibriE2EFixture
    {
        [UnityTest]
        public IEnumerator ConnectsAndAnnouncesItselfAsAV3Client()
        {
            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.Connected));
            Assert.That(Connection.AppName, Is.EqualTo(E2EServer.App));
            Assert.That(Connection.ServerAddress, Is.EqualTo(E2EServer.Host));
            Assert.That(Connection.TcpPort, Is.EqualTo(E2EServer.TcpPort));

            // The handshake's version field. colibri-web sends the same '2', and the server shows
            // it on the admin UI's Clients page.
            Assert.That(WebServerConnection.ClientVersion, Is.EqualTo("2"));

            yield break;
        }

        /// <summary>
        /// The server heartbeats every 100 ms and the client drops the connection after 2 s of
        /// silence. A client that stops echoing looks perfectly healthy from the outside until it
        /// is dropped, which is exactly how the Run In Background trap hid for so long.
        /// </summary>
        [UnityTest]
        public IEnumerator TheHeartbeatKeepsArrivingWhileConnected()
        {
            var worstGap = 0L;
            var deadline = Time.realtimeSinceStartup + 3f;

            while (Time.realtimeSinceStartup < deadline)
            {
                worstGap = Math.Max(worstGap, Connection.MillisSinceLastHeartbeat());
                yield return null;
            }

            Assert.That(worstGap, Is.LessThan(1000),
                $"The longest gap between heartbeats was {worstGap} ms; the client gives up at 2000 ms");
            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.Connected));
        }

        [UnityTest]
        public IEnumerator TheServerHeartbeatsEveryClient()
        {
            yield return E2EServer.Settle(1f);

            // ~10 in a second; one is enough to prove the peer is being kept alive too.
            Assert.That(Peer.Heartbeats, Is.GreaterThan(0));
        }

        /// <summary>
        /// Both ends really are on the same app. Everything else in the suite depends on this, and
        /// when it is wrong every other test fails as a timeout with no clue why.
        /// </summary>
        [UnityTest]
        public IEnumerator AMessageFromUnityReachesAPeerOnTheSameApp()
        {
            var channel = E2EServer.Channel("handshake-check");

            Sync.Send(channel, "ping");

            yield return Peer.Expect(channel, "broadcast::string",
                frame => Assert.That(TcpPeer.Text(frame), Is.EqualTo("\"ping\"")));
        }

        /// <summary>
        /// The server excludes the sender from its own broadcasts. Worth pinning down: without it,
        /// a SyncBehaviour would echo every change back to itself.
        /// </summary>
        [UnityTest]
        public IEnumerator TheSenderDoesNotReceiveItsOwnBroadcast()
        {
            var channel = E2EServer.Channel("echo-check");
            var received = 0;
            Action<string> handler = _ => received++;

            Sync.Receive(channel, handler);
            try
            {
                Sync.Send(channel, "into the void");
                yield return E2EServer.Settle(1f);

                Assert.That(received, Is.Zero, "The client received its own broadcast back");
            }
            finally
            {
                Sync.Unregister(channel, handler);
            }
        }
    }
}
