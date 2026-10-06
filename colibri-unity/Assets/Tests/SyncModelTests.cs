using System;
using System.Collections;
using System.Linq;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>A model with one [Sync] member of each shape a student is likely to reach for.</summary>
    public class E2ESyncModel : SyncBehaviour<E2ESyncModel>
    {
        [Sync]
        public string Label = "";

        /// <summary>Private and serialized, the way an Inspector-driven field is normally written.</summary>
        [Sync, SerializeField]
        private int _count;

        [Sync]
        public Vector3 Where { get; set; }

        public int Count
        {
            get => _count;
            set => _count = value;
        }
    }

    public class E2ESyncModelManager : SyncBehaviourManager<E2ESyncModel>
    {
    }

    /// <summary>
    /// <c>SyncBehaviour</c> over a real server: what actually goes on the wire when a [Sync] member
    /// changes, and what happens at the other end when a model arrives that this client has never
    /// seen.
    /// </summary>
    public class SyncModelTests : ColibriE2EFixture
    {
        /// <summary><c>SyncBehaviour</c> derives its channel from the type name, lowercased.</summary>
        private const string Channel = "e2esyncmodel";

        /// <summary>
        /// A model does not report changes until the server has answered its <c>model::request</c>
        /// with the state it already holds - otherwise a local value would overwrite the shared one
        /// the moment it arrived. So every test here has to let that round trip finish before it
        /// touches a field, or the change is latched and never sent.
        /// </summary>
        private static IEnumerator LetInitialStateArrive() => E2EServer.Settle(1.5f);

        [UnityTest]
        public IEnumerator APublicFieldReachesTheOtherClient()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Label = "hello";

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(model.Id));
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("hello"));
            });
        }

        [UnityTest]
        public IEnumerator APrivateSerializedFieldReachesTheOtherClient()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Count = 7;

            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["_count"].Value<int>(), Is.EqualTo(7)));
        }

        [UnityTest]
        public IEnumerator APropertyReachesTheOtherClient()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Where = new Vector3(1f, 2f, 3f);

            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["where"].ToString(Newtonsoft.Json.Formatting.None),
                    Is.EqualTo("[1.0,2.0,3.0]")));
        }

        /// <summary>
        /// One message per frame carrying only what changed, not one message per changed member and
        /// not the whole model. This is the difference between a sync loop that scales and one that
        /// floods the server with every field of every object.
        /// </summary>
        [UnityTest]
        public IEnumerator OnlyTheChangedMembersAreSent()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Label = "only this";

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                var members = payload.Properties().Select(p => p.Name).OrderBy(n => n).ToArray();

                Assert.That(members, Is.EqualTo(new[] { "id", "label" }),
                    $"Expected only the changed member alongside the id, got {string.Join(", ", members)}");
            });
        }

        [UnityTest]
        public IEnumerator SeveralMembersChangedInOneFrameTravelAsOneMessage()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Label = "both";
            model.Count = 3;

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("both"));
                Assert.That(payload["_count"].Value<int>(), Is.EqualTo(3));
            });

            yield return Peer.ExpectNothing(Channel);
        }

        /// <summary>
        /// A value from another client must not cost this client its next change of the same
        /// member. Echo suppression used to be a "swallow the next change" flag per member, set
        /// whenever an update changed the value. When the poll then saw no change - two updates
        /// that ended where they started before it ran - the flag stayed set and ate the next
        /// genuine local change: never sent, nothing logged.
        /// </summary>
        /// <remarks>
        /// Turning the component off stops the poll, which stands in for the two updates being
        /// handled in the same frame - a timing a test cannot arrange on purpose.
        /// </remarks>
        [UnityTest]
        public IEnumerator AValueFromAnotherClientDoesNotSwallowTheNextLocalChange()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.enabled = false;

            Peer.Send(Channel, "model::update", new JObject { { "id", model.Id }, { "label", "theirs" } });
            yield return E2EServer.WaitUntil(() => model.Label == "theirs", "The update from the peer never arrived");

            Peer.Send(Channel, "model::update", new JObject { { "id", model.Id }, { "label", "" } });
            yield return E2EServer.WaitUntil(() => model.Label == "", "The second update from the peer never arrived");

            model.enabled = true;

            // Neither value is this client's own, so neither may be echoed back.
            yield return Peer.ExpectNothing(Channel);

            model.Label = "mine";

            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo("mine")));
        }

        /// <summary>
        /// A model this client has never seen arrives from someone else, and the manager builds it
        /// from the template - exactly once. Instantiating it twice is the classic failure here,
        /// and it is invisible until two clients start fighting over the same id.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelFromAnotherClientIsInstantiatedExactlyOnce()
        {
            var template = SpawnConfigured<E2ESyncModel>("template", _ => { });
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;

            // Start is where the manager subscribes; nothing before it runs would be seen.
            yield return null;
            yield return LetInitialStateArrive();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "from the peer" } });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the model '{id}' it was told about");

            // Long enough for a second instantiation to show up if the manager is going to make one.
            yield return E2EServer.Settle(1.5f);

            var instances = Instances(id);
            Assert.That(instances.Length, Is.EqualTo(1),
                $"The manager created {instances.Length} objects for one model");
            Assert.That(instances[0].Label, Is.EqualTo("from the peer"));

            foreach (var instance in instances)
                UnityEngine.Object.Destroy(instance.gameObject);
        }

        /// <summary>
        /// Templates are often kept switched off in the scene, so that they are not objects of their
        /// own. A clone starts out as its template is, and a clone that is off never ran Awake: it
        /// never registered for its own updates or with the ticker, and stayed exactly as the first
        /// update had left it - invisible, deaf and mute.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelBuiltFromAnInactiveTemplateIsVisibleAndKeepsSyncing()
        {
            var templateObject = Spawn("inactive-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<E2ESyncModel>();
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;

            yield return null;
            yield return LetInitialStateArrive();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "from the peer" } });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the model '{id}' it was told about");

            var clone = Instances(id).Single();
            try
            {
                Assert.That(clone.gameObject.activeSelf, Is.True, "The clone of an inactive template stayed inactive");
                Assert.That(clone.Label, Is.EqualTo("from the peer"));
                Assert.That(templateObject.activeSelf, Is.False, "The template itself was switched on");

                // Later updates reach it...
                Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "changed" } });
                yield return E2EServer.WaitUntil(() => clone.Label == "changed", "The clone never received a later update");

                // ...without being echoed, and its own changes go out.
                yield return Peer.ExpectNothing(Channel);

                clone.Label = "local";
                yield return Peer.Expect(Channel, "model::update", frame =>
                {
                    var payload = TcpPeer.Json(frame);
                    Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
                    Assert.That(payload["label"].Value<string>(), Is.EqualTo("local"));
                });
            }
            finally
            {
                UnityEngine.Object.Destroy(clone.gameObject);
            }
        }


        /*
         *  The send-rate limit (SyncSettings.MaxSendRate). Set low here, so that what it holds
         *  back is plain to see at any frame rate; the default is 30 per second.
         */

        [UnityTest]
        public IEnumerator ABurstOfChangesSendsTheFirstAtOnceAndThenOnlyTheLatestValues()
        {
            var model = SpawnConfigured<E2ESyncModel>("burst", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            try
            {
                model.Label = "first";

                // Well inside the interval: a change after a quiet spell is not held back.
                yield return Peer.Expect(Channel, "model::update",
                    frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo("first")),
                    timeoutSeconds: 0.5f);

                model.Label = "between";
                yield return null;
                model.Count = 3;
                yield return null;
                model.Label = "last";

                // Nothing changes after this, and the held values still have to arrive - as one
                // update, without the value in between.
                yield return Peer.Expect(Channel, "model::update", frame =>
                {
                    var payload = TcpPeer.Json(frame);
                    Assert.That(payload["label"].Value<string>(), Is.EqualTo("last"));
                    Assert.That(payload["_count"].Value<int>(), Is.EqualTo(3));
                });

                yield return Peer.ExpectNothing(Channel, 1.5f);
            }
            finally
            {
                SyncSettings.ResetMaxSendRate();
            }
        }

        [UnityTest]
        public IEnumerator ALimitOfZeroSendsEveryFramesChange()
        {
            var model = SpawnConfigured<E2ESyncModel>("unlimited", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 0;
            try
            {
                model.Label = "a";
                yield return null;
                model.Label = "b";
                yield return null;
                model.Label = "c";

                foreach (var expected in new[] { "a", "b", "c" })
                {
                    yield return Peer.Expect(Channel, "model::update",
                        frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo(expected)));
                }
            }
            finally
            {
                SyncSettings.ResetMaxSendRate();
            }
        }

        /// <summary>
        /// Quitting must not cost the last changes: the server keeps the object for the clients
        /// that stay, and it would keep it where it was a moment before. Unity sends
        /// OnApplicationQuit to every active object before tearing any down; here it is sent to
        /// the ticker alone, since quitting for real would end the test run.
        /// </summary>
        [UnityTest]
        public IEnumerator WhatTheLimitHoldsIsSentWhenTheAppQuits()
        {
            var model = SpawnConfigured<E2ESyncModel>("held-at-quit", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            try
            {
                model.Label = "sent";
                yield return Peer.Expect(Channel, "model::update");

                model.Label = "held";
                yield return null;
                yield return null;

                var ticker = Resources.FindObjectsOfTypeAll<SyncTicker>().Single();
                ticker.SendMessage("OnApplicationQuit", SendMessageOptions.DontRequireReceiver);

                yield return Peer.Expect(Channel, "model::update",
                    frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo("held")),
                    timeoutSeconds: 0.5f);
            }
            finally
            {
                SyncSettings.ResetMaxSendRate();
            }
        }

        /// <summary>
        /// The delete goes out at once, and what the limit was holding goes nowhere: sent after the
        /// delete, it would bring the object back on the server and on every other client.
        /// </summary>
        [UnityTest]
        public IEnumerator DestroyingAnObjectDeletesItAtOnceAndDropsWhatWasHeld()
        {
            var model = SpawnConfigured<E2ESyncModel>("destroyed-while-held", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            try
            {
                model.Label = "sent";
                yield return Peer.Expect(Channel, "model::update");

                model.Label = "held";
                yield return null;
                yield return null;

                var id = model.Id;
                UnityEngine.Object.Destroy(model.gameObject);

                yield return Peer.Expect(Channel, "model::delete",
                    frame => Assert.That(TcpPeer.Json(frame)["id"].Value<string>(), Is.EqualTo(id)),
                    timeoutSeconds: 0.5f);

                yield return Peer.ExpectNothing(Channel, 1.5f);
            }
            finally
            {
                SyncSettings.ResetMaxSendRate();
            }
        }

        private static E2ESyncModel[] Instances(string id)
            => UnityEngine.Object.FindObjectsByType<E2ESyncModel>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .Where(m => m.Id == id)
                .ToArray();
    }
}
