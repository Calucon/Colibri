using System;
using System.Collections;
using System.Linq;
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


        /*
         *  The socket does not run on the main thread.
         *
         *  It used to, without anyone deciding that it should: RunConnectionLoop is started from
         *  OnEnable, so the first await captured Unity's SynchronizationContext and every
         *  continuation after it - receive, heartbeat echo, send - was posted back and pumped once
         *  per frame. Two editors side by side on one machine showed it plainly: the unfocused one
         *  is throttled by Unity, so the cube it was told to move arrived visibly late and its
         *  Status window reported missed heartbeats, all of it on localhost.
         */

        /// <summary>
        /// The test that would have caught it. A blocked main thread must not stop the client
        /// hearing the server: the stamp comes off the socket, and the socket is not the main
        /// thread's business.
        /// </summary>
        [UnityTest]
        public IEnumerator TheHeartbeatKeepsBeingStampedWhileTheMainThreadIsBlocked()
        {
            // A clean starting point - the fixture's setup does its own waiting around.
            yield return E2EServer.Settle(0.5f);

            // Long enough that the server (100 ms heartbeats) has had ten chances to be heard,
            // and far past the 500 ms the Status window calls a missed heartbeat.
            System.Threading.Thread.Sleep(1000);

            // Read before yielding: yielding hands the main thread back, and if the continuations
            // were queued on it they would all flush and reset the stamp before it was measured.
            var gap = Connection.MillisSinceLastHeartbeat();

            Assert.That(gap, Is.LessThan(500),
                $"The main thread was blocked for 1 s and the last heartbeat is {gap} ms old, so "
                + "the socket is being pumped by the main thread. Every received message waits for "
                + "a frame, which is the visible sync delay between two editors and the missed "
                + "heartbeats that come with it");
            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.Connected));
        }

        [UnityTest]
        public IEnumerator TheReceiveLoopRunsOffTheMainThread()
        {
            var mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;

            yield return E2EServer.WaitUntil(
                () => Connection.ReceiveThreadId != 0,
                "Nothing was ever received, so there was no thread to check",
                5f);

            Assert.That(Connection.ReceiveThreadId, Is.Not.EqualTo(mainThreadId),
                "The receive loop is running on the main thread, so inbound bytes are only picked "
                + "up as fast as the player loop runs");
        }

        /// <summary>
        /// The Status window's "Recent messages" list is meant to show what is happening now.
        /// Entries used to have no expiry at all, so a list from a minute ago sat there with its
        /// ages counting up - and, with domain reload disabled, into the next Play session too.
        /// </summary>
        [UnityTest]
        public IEnumerator TrafficEntriesAgeOutOfTheRecentMessagesLog()
        {
            var retention = Sync.TrafficRetentionSeconds;
            Sync.TrafficRetentionSeconds = 0.5f;

            try
            {
                Sync.Send(E2EServer.Channel("traffic-age-out"), "now");
                Assert.That(Sync.RecentTraffic.Any(), Is.True,
                    "The message that was just sent is not in the log at all");

                yield return E2EServer.Settle(1f);

                Assert.That(Sync.RecentTraffic.Any(), Is.False,
                    "Messages older than the retention window are still being listed");
            }
            finally
            {
                Sync.TrafficRetentionSeconds = retention;
            }
        }
    }
}
