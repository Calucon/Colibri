using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// What a model does with the server's answer to the request it makes again after every
    /// reconnect. The server clears an app's models when its last client leaves, so a client that
    /// was alone when its connection dropped comes back to a server that holds nothing of its
    /// objects - and answers each request with a bare <c>{ id }</c>. Nothing put the state back,
    /// and every client that joined afterwards was missing those objects.
    /// </summary>
    public class ModelResyncTests
    {
        private class ResyncModel : SyncBehaviour<ResyncModel>
        {
            [Sync]
            public string Label = "";

            [Sync]
            public int Count;

            /// <summary>Edit mode never calls Awake, which is where change tracking is set up.</summary>
            public void Wake() => Awake();
        }

        private class ResyncTransform : GenericSyncTransform<ResyncTransform>
        {
            public void Wake() => Awake();
        }

        private readonly List<GameObject> _gameObjects = new List<GameObject>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var gameObject in _gameObjects)
            {
                if (gameObject != null)
                    Object.DestroyImmediate(gameObject);
            }
            _gameObjects.Clear();

            // Awake registers listeners, and that creates the connection singleton - in edit mode
            // an inert component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in Object.FindObjectsByType<WebServerConnection>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                Object.DestroyImmediate(connection.gameObject);
        }

        private T Spawn<T>(string name) where T : Component
        {
            var gameObject = new GameObject(name);
            _gameObjects.Add(gameObject);
            return gameObject.AddComponent<T>();
        }

        private ResyncModel SpawnModel()
        {
            var model = Spawn<ResyncModel>("resync-model");
            model.Wake();
            return model;
        }

        private static JObject Bare(string id) => new JObject { { "id", id } };

        /// <summary>Whatever the model would send now, without a send-rate limit.</summary>
        private static JObject Sent<T>(SyncBehaviour<T> model) where T : SyncBehaviour<T>
            => model.TakeDueUpdate(100.0, interval: 0);

        private static string[] Members(JObject update)
            => update.Properties().Select(p => p.Name).OrderBy(n => n).ToArray();

        /// <summary>
        /// The first bare answer is how every new object starts, and sends nothing of its own: a
        /// manager's TriggerSync decides whether the full state goes out, as it always did.
        /// </summary>
        [Test]
        public void TheFirstBareAnswerSendsNothing()
        {
            var model = SpawnModel();

            model.OnModelUpdate(Bare(model.Id));

            Assert.That(Sent(model), Is.Null);
        }

        [Test]
        public void ALaterBareAnswerSendsTheFullState()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.Label = "mine";
            model.Count = 3;
            ((SyncTicker.ITickable)model).PollChanges();
            Assert.That(Sent(model), Is.Not.Null, "Precondition: the change goes out");

            model.OnModelUpdate(Bare(model.Id));
            var sent = Sent(model);

            Assert.That(sent, Is.Not.Null, "The server has lost the model, and nothing put it back");
            Assert.That(Members(sent), Is.EqualTo(new[] { "count", "id", "label" }));
            Assert.That(sent["id"].Value<string>(), Is.EqualTo(model.Id));
            Assert.That(sent["label"].Value<string>(), Is.EqualTo("mine"));
            Assert.That(sent["count"].Value<int>(), Is.EqualTo(3));
        }

        /// <summary>
        /// The full state that answers a bare answer reaches every other client as an update with
        /// members, and one of those is applied without anything going back - so two clients
        /// cannot set each other off.
        /// </summary>
        [Test]
        public void AnUpdateWithMembersSendsNothingBack()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.OnModelUpdate(new JObject { { "id", model.Id }, { "label", "theirs" }, { "count", 5 } });
            ((SyncTicker.ITickable)model).PollChanges();

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(Sent(model), Is.Null);
        }

        [Test]
        public void AnAnswerForAnotherModelSendsNothing()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.OnModelUpdate(Bare("someone-else"));

            Assert.That(Sent(model), Is.Null);
        }

        /// <summary>The full state goes by a SyncTransform's boxes, like every other full state.</summary>
        [Test]
        public void TheFullStateLeavesOutTheMembersThatAreSwitchedOff()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.SyncPosition = false;
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            sync.OnModelUpdate(Bare(sync.Id));
            var sent = Sent(sync);

            Assert.That(sent, Is.Not.Null);
            Assert.That(Members(sent), Does.Not.Contain("position"), $"The unticked position went out: {sent}");
            Assert.That(Members(sent), Does.Contain("rotation"));
        }
    }
}
