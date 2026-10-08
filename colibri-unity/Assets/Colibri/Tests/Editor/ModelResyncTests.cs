using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Core;
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
    ///
    /// A model another client deleted meanwhile is answered with <c>model::delete</c> instead, as
    /// long as the server remembers the delete; ReconnectTests checks that against the server.
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
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
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

        /// <summary>Whatever the model would send at <paramref name="time"/>, on SyncTicker's clock.</summary>
        private static JObject SentAt<T>(SyncBehaviour<T> model, double time) where T : SyncBehaviour<T>
            => model.TakeDueUpdate(time, interval: 0);

        private static void Poll(object model) => ((SyncTicker.ITickable)model).PollChanges();

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


        /*
         *  An answer holding what the server had before this client's last changes, which were
         *  written into the connection as it died and lost. See SentValuesTests for the comparison.
         */

        /// <summary>The model, answered once and with a label that reached the server at 100.</summary>
        private ResyncModel SpawnModelThatSent(string label)
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.Label = label;
            Poll(model);
            Assert.That((string)SentAt(model, 100)["label"], Is.EqualTo(label), "Precondition: the change goes out");
            return model;
        }

        /// <summary>A change polled and sent at <paramref name="time"/>, into a connection that may be dead.</summary>
        private static void Change(ResyncModel model, string label, double time)
        {
            model.Label = label;
            Poll(model);
            Assert.That(SentAt(model, time), Is.Not.Null, "Precondition: the change goes out");
        }

        private static JObject Answer(ResyncModel model, string label, int count = 0)
            => new JObject { { "id", model.Id }, { "label", label }, { "count", count } };

        /// <summary>
        /// The answer to the request sent after all the others (see Sync.ReconnectRound): the
        /// answers to the requests made again are all in.
        /// </summary>
        private static void EndOfAnswers()
        {
            var marker = Sync.ReconnectRoundEndMarker;
            Assert.That(marker, Is.Not.Null, "Precondition: the answers to a reconnect's requests are still coming in");
            Sync.OnServerMessage(Sync.ReconnectRoundChannel, "model::update", new JObject { { "id", marker } });
        }

        /// <summary>A model::update another client sends, as the server relays it.</summary>
        private static JObject Relayed(ResyncModel model, string member, JToken value)
            => new JObject { { "id", model.Id }, { member, value } };

        /// <summary>The bug: the answer put the value from before the outage back, and nothing went out.</summary>
        [Test]
        public void AValueLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("before");
            Change(model, "lost at the drop", 101);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "before"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the value from before the outage back");
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what was lost goes out again: {sent}");
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>The trace that found it: a SyncTransform moved at the drop, answered in the server's own number format.</summary>
        [Test]
        public void APositionLostWithTheConnectionIsKeptAndSentAgain()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            sync.transform.position = new Vector3(0, -3, 0);
            Poll(sync);
            Assert.That(SentAt(sync, 100), Is.Not.Null);
            sync.transform.position = new Vector3(7, 0, 7);
            Poll(sync);
            Assert.That(SentAt(sync, 101), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            sync.OnModelUpdate(JObject.Parse($"{{\"id\":\"{sync.Id}\",\"active\":true,\"position\":[0,-3,0],\"scale\":[1,1,1]}}"));

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(7, 0, 7)), "The answer put the position from before the outage back");
            var sent = SentAt(sync, 104);
            Assert.That(sent, Is.Not.Null, "The position that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "position" }), $"Only what was lost goes out again: {sent}");
            Assert.That(sent["position"].ToVector3(), Is.EqualTo(new Vector3(7, 0, 7)));
        }

        /// <summary>
        /// The other side: what the server holds is no value of this client's, so another client set
        /// it while this one was away - and that is the newer change.
        /// </summary>
        [Test]
        public void AValueAnotherClientSetDuringTheOutageIsApplied()
        {
            var model = SpawnModelThatSent("mine");
            Change(model, "mine, lost at the drop", 101);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "theirs"));

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(SentAt(model, 104), Is.Null);
        }

        /// <summary>
        /// What was sent last arrived: nothing to do, and nothing to undo either - a change made here
        /// since then stays and goes out as usual.
        /// </summary>
        [Test]
        public void AnAnswerHoldingTheValueSentLastLeavesTheObjectAlone()
        {
            var model = SpawnModelThatSent("mine");

            model.Label = "changed since";
            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "mine"));

            Assert.That(model.Label, Is.EqualTo("changed since"));
            Poll(model);
            var sent = SentAt(model, 104);
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }));
            Assert.That((string)sent["label"], Is.EqualTo("changed since"));
        }

        /// <summary>Everything the answer shows to have been lost goes out again, as one update.</summary>
        [Test]
        public void EverythingLostWithTheConnectionGoesOutAgainAsOneUpdate()
        {
            var model = SpawnModelThatSent("before");
            model.Count = 1;
            Poll(model);
            Assert.That(SentAt(model, 100.5), Is.Not.Null);

            model.Label = "lost at the drop";
            model.Count = 5;
            Poll(model);
            Assert.That(SentAt(model, 101), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "before", 1));

            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null);
            Assert.That(Members(sent), Is.EqualTo(new[] { "count", "id", "label" }), $"All that was lost should go out as one update: {sent}");
            Assert.That((int)sent["count"], Is.EqualTo(5));
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// Another client's update, relayed while the answers are on their way, lacks a member this
        /// object sent: that says nothing about what the server holds for it, and it does not go
        /// out again. Sent again, it overwrote what another client had set during the outage, and
        /// the answer then put that client's value on this one: two values, for good.
        /// </summary>
        [Test]
        public void AMemberAnUpdateLacksIsNotSentAgain()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));
            model.Label = "mine";
            model.Count = 1;
            Poll(model);
            Assert.That(SentAt(model, 100), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Relayed(model, "label", "theirs, live"));
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Null, $"Nothing was lost, so nothing should go out again: {sent}");

            model.OnModelUpdate(Answer(model, "theirs, live", 7));
            EndOfAnswers();

            Assert.That(model.Label, Is.EqualTo("theirs, live"));
            Assert.That(model.Count, Is.EqualTo(7), "The count another client set during the outage was not applied");
            Assert.That(SentAt(model, 105), Is.Null);
        }

        /// <summary>
        /// A manager on the channel asks for every model on it again too, and the answer to that
        /// carries this model as well: two answers, both from before the lost change. Both are
        /// judged, and the lost value goes out once. After the answer that marks the end of them,
        /// an update is applied as it arrives, even one holding a value this object sent before.
        /// </summary>
        [Test]
        public void EverythingUntilTheEndOfTheAnswersIsJudged()
        {
            var model = SpawnModelThatSent("before");
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                Change(model, "lost at the drop", 101);
                Sync.RequestModelsAgain(disconnectedAt: 103);

                model.OnModelUpdate(Answer(model, "before"));
                Assert.That((string)SentAt(model, 104)["label"], Is.EqualTo("lost at the drop"));

                model.OnModelUpdate(Answer(model, "before"));
                Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The second answer put the value from before the outage back");
                Assert.That(SentAt(model, 105), Is.Null, "The second answer sent the lost value a second time");

                EndOfAnswers();
                model.OnModelUpdate(Answer(model, "before"));
                Assert.That(model.Label, Is.EqualTo("before"), "An update after the answers should be applied as it arrives");
                Assert.That(SentAt(model, 106), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// Another client's update, relayed ahead of the answers, does not take the place of one:
        /// both answers are still judged, and the value from before the outage is not put back
        /// here after the lost one has gone out again to everyone else.
        /// </summary>
        [Test]
        public void AnotherClientsUpdateAheadOfTheAnswersDoesNotLetOneThrough()
        {
            var model = SpawnModelThatSent("before");
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                Change(model, "lost at the drop", 101);
                Sync.RequestModelsAgain(disconnectedAt: 103);

                model.OnModelUpdate(Relayed(model, "count", 3));
                model.OnModelUpdate(Answer(model, "before", 3));
                var sent = SentAt(model, 104);
                model.OnModelUpdate(Answer(model, "before", 3));
                EndOfAnswers();

                Assert.That(model.Label, Is.EqualTo("lost at the drop"), "An answer put the value from before the outage back");
                Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
                Assert.That((string)sent["label"], Is.EqualTo(model.Label), "What went out to everyone else differs from what this client shows");
                Assert.That(model.Count, Is.EqualTo(3));
                Assert.That(SentAt(model, 105), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// Once a member's last change is known to have been lost, nothing else that arrives before
        /// the end of the answers is applied to it: the server had all of that before it read the
        /// value sent again, which then replaces it there and on every other client. Applied here,
        /// this client alone would show it.
        /// </summary>
        [Test]
        public void AMemberFoundLostTakesNothingMoreFromTheAnswers()
        {
            var model = SpawnModelThatSent("before");
            Change(model, "lost at the drop", 101);
            Sync.RequestModelsAgain(disconnectedAt: 103);

            model.OnModelUpdate(Answer(model, "before"));
            Assert.That((string)SentAt(model, 104)["label"], Is.EqualTo("lost at the drop"));

            model.OnModelUpdate(Relayed(model, "label", "theirs, sent before the server read ours"));
            Assert.That(model.Label, Is.EqualTo("lost at the drop"));
            Assert.That(SentAt(model, 105), Is.Null);

            EndOfAnswers();
            model.OnModelUpdate(Relayed(model, "label", "theirs, sent after"));
            Assert.That(model.Label, Is.EqualTo("theirs, sent after"), "After the answers, another client's update should be applied as it arrives");
            Assert.That(SentAt(model, 106), Is.Null);
        }

        /// <summary>
        /// The end of the answers is the answer to the request sent after all the others, however
        /// many answers came before it: one where two were expected, say. An update after it is
        /// applied as it arrives, even long after and even one holding a value this object sent.
        /// </summary>
        [Test]
        public void AnUpdateAfterTheEndOfTheAnswersIsAppliedAsItArrives()
        {
            var model = SpawnModelThatSent("before");
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                Sync.RequestModelsAgain(disconnectedAt: 103);
                model.OnModelUpdate(Answer(model, "before"));
                EndOfAnswers();

                Change(model, "a", 500);
                Change(model, "b", 501);
                model.OnModelUpdate(Relayed(model, "label", "a"));

                Assert.That(model.Label, Is.EqualTo("a"));
                Assert.That(SentAt(model, 600), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// The answer to an earlier round's last request - one a failed write kept for the next
        /// connection - does not end the current round.
        /// </summary>
        [Test]
        public void TheEndOfAnEarlierRoundDoesNotEndTheCurrentOne()
        {
            var model = SpawnModelThatSent("before");
            Sync.RequestModelsAgain(disconnectedAt: 101);
            var earlier = Sync.ReconnectRoundEndMarker;

            Change(model, "lost at the drop", 102);
            Sync.RequestModelsAgain(disconnectedAt: 104);
            Sync.OnServerMessage(Sync.ReconnectRoundChannel, "model::update", new JObject { { "id", earlier } });
            Assert.That(Sync.ReconnectRoundEndMarker, Is.Not.Null.And.Not.EqualTo(earlier));

            model.OnModelUpdate(Answer(model, "before"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"));
            Assert.That((string)SentAt(model, 105)["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// An object that never sent anything - one a manager built from another client's update -
        /// takes the answer as it always did.
        /// </summary>
        [Test]
        public void AnObjectThatNeverSentAnythingAppliesTheAnswer()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Answer(model, "theirs"));

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "theirs, changed offline", 4));

            Assert.That(model.Label, Is.EqualTo("theirs, changed offline"));
            Assert.That(model.Count, Is.EqualTo(4));
            Assert.That(SentAt(model, 104), Is.Null);
        }

        /// <summary>
        /// Changed long before the outage: another client setting the member back to one of those
        /// values during the outage looks the same as a lost change, so they do not count.
        /// </summary>
        [Test]
        public void ValuesSentLongBeforeTheOutageDoNotCount()
        {
            var model = SpawnModelThatSent("first");
            Change(model, "second", 101);

            Sync.RequestModelsAgain(disconnectedAt: 101 + SentValues.WindowSeconds + 1);
            model.OnModelUpdate(Answer(model, "first"));

            Assert.That(model.Label, Is.EqualTo("first"));
            Assert.That(SentAt(model, 200), Is.Null);
        }

        /// <summary>
        /// Once the member has taken another client's value, what it sent before says nothing about
        /// the server: set back to one of those values during the outage, it is that client's change.
        /// </summary>
        [Test]
        public void ValuesSentBeforeTakingAnotherClientsValueDoNotCount()
        {
            var model = SpawnModelThatSent("first");
            Change(model, "second", 101);
            model.OnModelUpdate(Answer(model, "theirs"));
            Change(model, "mine", 102);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "first"));

            Assert.That(model.Label, Is.EqualTo("first"));
            Assert.That(SentAt(model, 104), Is.Null);
        }

        /// <summary>
        /// The case the window alone missed: a member left alone for longer than the window, then
        /// changed once at the drop - an object switched off after a minute switched on. Nothing but
        /// the lost value was sent in the window, and the answer holds the value the member had held
        /// all along: that change was lost.
        /// </summary>
        [Test]
        public void AChangeAfterAQuietSpellLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("held for a while");
            Change(model, "lost at the drop", 200);

            const double outage = 202;
            Assert.That(100, Is.LessThan(outage - SentValues.WindowSeconds), "Precondition: the first value was sent before the window");
            Sync.RequestModelsAgain(disconnectedAt: outage);
            model.OnModelUpdate(Answer(model, "held for a while"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the value from before the quiet spell back");
            var sent = SentAt(model, 203);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what was lost goes out again: {sent}");
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// The same for a value this object never sent: the server's, applied when the object came
        /// up, and held ever since.
        /// </summary>
        [Test]
        public void AChangeToTheStateTheObjectCameUpWithLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Answer(model, "the server's", 2));
            Change(model, "lost at the drop", 200);

            Sync.RequestModelsAgain(disconnectedAt: 202);
            model.OnModelUpdate(Answer(model, "the server's", 2));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the state the object came up with back");
            var sent = SentAt(model, 203);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what was lost goes out again: {sent}");
        }

        /// <summary>
        /// Taking another client's value forgets what the member sent before, but not the value
        /// taken: the first change after it, lost at the drop, is recognised by it.
        /// </summary>
        [Test]
        public void TheFirstChangeAfterAnotherClientsValueLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("mine");
            model.OnModelUpdate(Relayed(model, "label", "theirs"));
            Assert.That(model.Label, Is.EqualTo("theirs"), "Precondition: the other client's value is applied");
            Change(model, "lost at the drop", 101);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "theirs"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the other client's value back");
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// The value held when the window began counts, but nothing else does: after a quiet spell, a
        /// value this member never held is another client's, and still wins over the one lost.
        /// </summary>
        [Test]
        public void AValueThisMemberNeverHeldStillWinsAfterAQuietSpell()
        {
            var model = SpawnModelThatSent("held for a while");
            model.OnModelUpdate(Relayed(model, "count", 4));
            Change(model, "lost at the drop", 200);
            model.Count = 5;
            Poll(model);
            Assert.That(SentAt(model, 200.5), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 202);
            model.OnModelUpdate(Answer(model, "theirs", 6));

            Assert.That(model.Label, Is.EqualTo("theirs"), "The other client's label, set during the outage, was not applied");
            Assert.That(model.Count, Is.EqualTo(6), "The other client's count, set during the outage, was not applied");
            Assert.That(SentAt(model, 203), Is.Null);
        }
    }
}
