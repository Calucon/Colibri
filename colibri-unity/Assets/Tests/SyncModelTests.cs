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

        private static E2ESyncModel[] Instances(string id)
            => UnityEngine.Object.FindObjectsByType<E2ESyncModel>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .Where(m => m.Id == id)
                .ToArray();
    }
}
