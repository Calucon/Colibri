using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
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


        /// <summary>
        /// The bound on an outage's queue must not cost model state, which nothing would repair:
        /// an object changed once early in the outage, while broadcasts kept coming, used to be
        /// dropped first - and the re-request after reconnecting then reverted it locally to the
        /// server's older copy. A dropped request leaves an object waiting for its first state for
        /// good; a dropped delete leaves it alive on every other client. Instead, an object's
        /// updates during an outage are folded into one, and only the broadcasts are capped.
        /// </summary>
        [UnityTest]
        public IEnumerator ALongOutageKeepsEveryObjectsLatestStateAndItsRequestsAndDeletes()
        {
            const int broadcastsSent = 300;
            const int broadcastsKept = 256;
            var channel = E2EServer.Channel("outage-models");
            var noiseChannel = E2EServer.Channel("outage-noise");
            var early = System.Guid.NewGuid().ToString();
            var moving = System.Guid.NewGuid().ToString();
            var requested = System.Guid.NewGuid().ToString();
            var deleted = System.Guid.NewGuid().ToString();
            System.Action<JObject> listener = _ => { };

            yield return CutTheConnection();
            try
            {
                // Changed once, at the very start of the outage...
                Sync.SendModelUpdate(channel, new JObject { { "id", early }, { "label", "early" } });

                // ...then more broadcasts than the queue holds...
                for (var i = 1; i <= broadcastsSent; i++)
                    Sync.Send(noiseChannel, i);

                // ...an object that keeps changing, one member and then another...
                Sync.SendModelUpdate(channel, new JObject { { "id", moving }, { "label", "first" } });
                for (var i = 1; i <= 100; i++)
                    Sync.SendModelUpdate(channel, new JObject { { "id", moving }, { "count", i } });

                // ...a new object asking for its state, and one going away.
                Sync.AddModelUpdateListener(channel, listener, requested);
                Sync.SendModelDelete(channel, deleted);

                yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                    "The client never reconnected after the outage", 20f);

                // The delete was queued last, so once it is through, so is everything before it.
                yield return E2EServer.WaitUntil(() => SecondSession().Any(f => f.Channel == channel && f.Command == "model::delete"),
                    "The messages queued during the outage never went out");

                var sent = SecondSession().Where(f => f.Channel == channel).ToList();
                var updates = sent.Where(f => f.Command == "model::update").Select(TcpPeer.Json).ToList();

                var earlyUpdates = updates.Where(u => (string)u["id"] == early).ToList();
                Assert.That(earlyUpdates.Count, Is.EqualTo(1), "The update from the start of the outage was dropped to make room for broadcasts");
                Assert.That((string)earlyUpdates[0]["label"], Is.EqualTo("early"));

                var movingUpdates = updates.Where(u => (string)u["id"] == moving).ToList();
                Assert.That(movingUpdates.Count, Is.EqualTo(1), "An object's updates during an outage should travel as one");
                Assert.That((string)movingUpdates[0]["label"], Is.EqualTo("first"), "The member changed first was lost when the updates were combined");
                Assert.That((int)movingUpdates[0]["count"], Is.EqualTo(100), "The combined update does not carry the newest value");

                Assert.That(sent.Any(f => f.Command == "model::request" && (string)TcpPeer.Json(f)["id"] == requested), Is.True,
                    "The request a new object made during the outage was dropped");
                Assert.That(sent.Any(f => f.Command == "model::delete" && (string)TcpPeer.Json(f)["id"] == deleted), Is.True,
                    "The delete made during the outage was dropped");

                // The broadcasts are what the bound is for: the newest of them, in order.
                var noise = SecondSession().Where(f => f.Channel == noiseChannel).Select(f => int.Parse(TcpPeer.Text(f))).ToArray();
                Assert.That(noise, Is.EqualTo(Enumerable.Range(broadcastsSent - broadcastsKept + 1, broadcastsKept).ToArray()));
            }
            finally
            {
                Sync.RemoveModelUpdateListener(channel, listener);
            }
        }


        /*
         *  State that changed while the client was offline
         */

        /// <summary>
        /// <c>model::request</c> used to be sent once, when a listener registered, so a client
        /// coming back from an outage kept whatever it had - for every model another client had
        /// changed in the meantime - until that model happened to change again. Every reconnect now
        /// repeats the requests, after the messages queued during the outage, so the server answers
        /// with this client's own offline changes already applied.
        /// </summary>
        [UnityTest]
        public IEnumerator ModelsThatChangedOfflineAreRequestedAgainOnReconnect()
        {
            var modelChannel = E2EServer.Channel("resync-model");
            var outageChannel = E2EServer.Channel("resync-outage");
            var id = System.Guid.NewGuid().ToString();
            var received = new List<JObject>();
            System.Action<JObject> listener = model => received.Add(model);

            Sync.AddModelUpdateListener(modelChannel, listener, id);
            var witness = new TcpPeer();
            try
            {
                yield return witness.Connect("resync-witness");

                // The answer to the request made at registration - a bare { id }, since the server
                // has never seen this model.
                yield return E2EServer.WaitUntil(() => received.Any(m => (string)m["id"] == id),
                    "The request made when the listener registered was never answered");

                // The client stays offline until the server has certainly taken the change below.
                _proxy.HoldNewConnections = true;
                yield return CutTheConnection();

                Sync.Send(outageChannel, 1);
                _peer.Send(modelChannel, "model::update", new JObject { { "id", id }, { "label", "changed offline" } });
                yield return witness.Expect(modelChannel, "model::update");

                _proxy.HoldNewConnections = false;
                yield return E2EServer.WaitUntil(() => received.Any(m => (string)m["label"] == "changed offline"),
                    "A model that changed while the client was offline never reached it after reconnecting", 20f);

                var secondSession = _proxy.FromClient.Where(sent => sent.Session == 2).Select(sent => sent.Frame).ToList();
                var request = secondSession.FindIndex(f => f.Channel == modelChannel && f.Command == "model::request");
                var queuedDuringOutage = secondSession.FindIndex(f => f.Channel == outageChannel);

                Assert.That(request, Is.GreaterThanOrEqualTo(0), "The client never asked for the model again after reconnecting");
                Assert.That((string)TcpPeer.Json(secondSession[request])["id"], Is.EqualTo(id));
                Assert.That(queuedDuringOutage, Is.GreaterThanOrEqualTo(0).And.LessThan(request),
                    "The request went out ahead of the messages queued during the outage, so the server answered without them");
            }
            finally
            {
                witness.Dispose();
                Sync.RemoveModelUpdateListener(modelChannel, listener);
            }
        }

        /// <summary>
        /// The same through SyncBehaviourManager, which builds objects from what the server sends:
        /// the model asked for again after a reconnect is one this client already has, and it has
        /// to update that object rather than build a second one.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelResyncedAfterAnOutageUpdatesItsObjectRatherThanSpawningAnother()
        {
            const string channel = "e2esyncmodel";
            var spawned = new List<GameObject>();
            var id = System.Guid.NewGuid().ToString();
            var witness = new TcpPeer();
            try
            {
                var template = Spawn<E2ESyncModel>(spawned, "template");
                var manager = Spawn<E2ESyncModelManager>(spawned, "manager");
                manager.Template = template;

                // Start is where the manager subscribes; then the template's own state round trip.
                yield return null;
                yield return E2EServer.Settle(1.5f);

                _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "before the outage" } });
                yield return E2EServer.WaitUntil(() => Instances(id).Length == 1,
                    $"The manager never instantiated the model '{id}' it was told about");

                yield return witness.Connect("resync-witness");
                _proxy.HoldNewConnections = true;
                yield return CutTheConnection();

                _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "changed offline" } });
                yield return witness.Expect(channel, "model::update");
                _proxy.HoldNewConnections = false;

                yield return E2EServer.WaitUntil(() => Instances(id).Any(m => m.Label == "changed offline"),
                    "The model that changed while the client was offline was not updated after reconnecting", 20f);

                // Long enough for a second instance to show up if the manager is going to make one.
                yield return E2EServer.Settle(1.5f);

                Assert.That(Instances(id).Length, Is.EqualTo(1),
                    "Asking for the model again after the reconnect built a second object for it");
            }
            finally
            {
                witness.Dispose();

                // Immediately, while this test's connection is still there: destroying a synced
                // object sends model::delete, and one sent after the teardown has destroyed the
                // connection would build a new one and deliver the delete into a later test.
                foreach (var instance in Instances(id))
                    Object.DestroyImmediate(instance.gameObject);
                foreach (var gameObject in spawned)
                {
                    if (gameObject)
                        Object.DestroyImmediate(gameObject);
                }
            }
        }

        /// <summary>
        /// RemoteLogging across an outage: every line reaches the server exactly once, in order.
        /// It used to retry a line whose send had failed, while the connection had also queued that
        /// same send for retry, so some lines arrived twice. Lines logged during the outage wait in
        /// RemoteLogging's own buffer and go out once the connection is back.
        /// </summary>
        [UnityTest]
        public IEnumerator RemoteLoggingDeliversEveryLineOnceAcrossAnOutage()
        {
            var prefix = $"reconnect-log-{System.Guid.NewGuid():N}";
            var loggingObject = new GameObject("remote-logging");
            try
            {
                loggingObject.AddComponent<RemoteLogging>();
                var next = 1;

                for (var i = 0; i < 5; i++)
                    Debug.Log($"{prefix} {next++}");
                yield return E2EServer.WaitUntil(() => LoggedLines(prefix).Length == 5,
                    "The lines logged before the outage never reached the server");

                yield return CutTheConnection();

                for (var i = 0; i < 5; i++)
                    Debug.Log($"{prefix} {next++}");

                yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                    "The client never reconnected after the outage", 20f);

                for (var i = 0; i < 5; i++)
                    Debug.Log($"{prefix} {next++}");

                var expected = Enumerable.Range(1, next - 1).Select(i => $"{prefix} {i}").ToArray();
                yield return E2EServer.WaitUntil(() => LoggedLines(prefix).Length >= expected.Length,
                    $"Only {LoggedLines(prefix).Length} of the {expected.Length} lines reached the server");

                // Past RemoteLogging's one-second send interval, so a duplicate would have shown up.
                yield return E2EServer.Settle(1.5f);

                Assert.That(LoggedLines(prefix), Is.EqualTo(expected), "Log lines arrived out of order, or more than once");
            }
            finally
            {
                // Immediately: left for the end of the frame, its Update could run after the
                // teardown has destroyed the connection, and would build a new one.
                Object.DestroyImmediate(loggingObject);
            }
        }


        /*
         *  Helpers
         */

        /// <summary>What the client sent on the connection after the first reconnect, in order.</summary>
        private List<Networking.Protocol.DecodedFrame> SecondSession()
            => _proxy.FromClient.Where(sent => sent.Session == 2).Select(sent => sent.Frame).ToList();

        private static T Spawn<T>(List<GameObject> spawned, string name) where T : Component
        {
            var gameObject = new GameObject(name);
            spawned.Add(gameObject);
            return gameObject.AddComponent<T>();
        }

        private static E2ESyncModel[] Instances(string id)
            => Object.FindObjectsByType<E2ESyncModel>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .Where(m => m.Id == id)
                .ToArray();

        /// <summary>The client's log lines with the given prefix, as the server received them, in order.</summary>
        private string[] LoggedLines(string prefix)
            => _proxy.FromClient
                .Where(sent => sent.Frame.Channel == "log")
                .Select(sent => TcpPeer.Text(sent.Frame))
                .Where(line => line.StartsWith(prefix))
                .ToArray();

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
