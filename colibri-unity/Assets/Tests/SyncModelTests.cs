using System;
using System.Collections;
using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>A model with one [Sync] member of each shape application code is likely to reach for.</summary>
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

    /// <summary>A model with a [Sync] setter that throws for one value, as a setter in application code can.</summary>
    public class E2EFragileModel : SyncBehaviour<E2EFragileModel>
    {
        public const string Refused = "refused";

        private string _label = "";

        [Sync]
        public string Label
        {
            get => _label;
            set
            {
                if (value == Refused)
                    throw new InvalidOperationException($"E2EFragileModel does not take the label '{Refused}'");
                _label = value;
            }
        }
    }

    public class E2EFragileModelManager : SyncBehaviourManager<E2EFragileModel>
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
        /// A manager without a template is how objects placed in the scene are synced, so it is not
        /// a mistake in itself. It used to warn at every Play regardless - the SyncTransform sample
        /// included - and now says so only when a model arrives that it would have to build, once,
        /// naming the model.
        /// </summary>
        [UnityTest]
        public IEnumerator AManagerWithoutATemplateWarnsOnceWhenItCannotBuildAModel()
        {
            var warnings = new System.Collections.Generic.List<string>();
            void OnLog(string message, string stackTrace, LogType type)
            {
                if (type == LogType.Warning && message.IndexOf("template", StringComparison.OrdinalIgnoreCase) >= 0)
                    warnings.Add(message);
            }

            Application.logMessageReceived += OnLog;
            try
            {
                var placed = SpawnConfigured<E2ESyncModel>("placed", _ => { });
                Spawn<E2ESyncModelManager>("manager-without-template");

                yield return null;
                yield return LetInitialStateArrive();

                // Updates for an object the scene has are no reason to warn.
                Peer.Send(Channel, "model::update", new JObject { { "id", placed.Id }, { "label", "known" } });
                yield return E2EServer.WaitUntil(() => placed.Label == "known", "The placed model never received its update");
                Assert.That(warnings, Is.Empty, "A manager without a template warned before it had anything to build");

                // Two updates of one unknown model and one of another: a single warning, for the first.
                var first = Guid.NewGuid().ToString();
                Peer.Send(Channel, "model::update", new JObject { { "id", first }, { "label", "a" } });
                Peer.Send(Channel, "model::update", new JObject { { "id", first }, { "label", "b" } });
                Peer.Send(Channel, "model::update", new JObject { { "id", Guid.NewGuid().ToString() }, { "label", "c" } });

                yield return E2EServer.WaitUntil(() => warnings.Count > 0,
                    "The manager never said that it could not build a model it has no template for");
                yield return E2EServer.Settle(1f);

                Assert.That(warnings, Has.Count.EqualTo(1), string.Join("\n", warnings));
                Assert.That(warnings[0], Does.Contain(first));
                Assert.That(warnings[0], Does.Not.Contain("  "), "The message has a gap where a value is missing");
                Assert.That(Instances(first), Is.Empty);
            }
            finally
            {
                Application.logMessageReceived -= OnLog;
            }
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

        /// <summary>
        /// Applying the first state of a model from another client can throw - here a [Sync]
        /// setter refuses the value. The manager had switched its template off, given it the
        /// remote id and noted that it was building an object, and put none of that back: the
        /// template kept the other client's id, and no object created on this client afterwards
        /// ever sent its state, since the manager still believed each one was its own clone.
        /// </summary>
        [UnityTest]
        public IEnumerator AStateThatThrowsWhileItIsAppliedDoesNotStopTheManager()
        {
            const string channel = "e2efragilemodel";

            var templateObject = Spawn("fragile-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<E2EFragileModel>();
            var templateId = template.Id;
            var manager = Spawn<E2EFragileModelManager>("fragile-manager");
            manager.Template = template;

            yield return null;
            yield return LetInitialStateArrive();

            LogAssert.Expect(LogType.Error, new Regex($"^Colibri: a listener for model::update on channel '{channel}' threw an exception"));

            // The second update reaches the server before the clone can ask for its state, so
            // only building the clone meets the refused value.
            var id = Guid.NewGuid().ToString();
            Peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", E2EFragileModel.Refused } });
            Peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "accepted" } });

            yield return E2EServer.WaitUntil(() => FragileInstances(id).Any(m => m.Label == "accepted"),
                $"The manager never built the model '{id}', or it never took the later update");

            var clones = FragileInstances(id);
            try
            {
                Assert.That(clones.Length, Is.EqualTo(1), $"{clones.Length} objects carry the id '{id}'");
                Assert.That(template.Id, Is.EqualTo(templateId), "The template kept the id of the model it was cloned for");
                Assert.That(template.enabled, Is.True, "The template was left switched off");
                Assert.That(clones[0].enabled, Is.True, "The clone was left switched off");

                // An object created here afterwards still sends its state.
                var local = SpawnConfigured<E2EFragileModel>("fragile-local", m => m.Label = "local");
                yield return Peer.Expect(channel, "model::update", frame =>
                {
                    var payload = TcpPeer.Json(frame);
                    Assert.That(payload["id"].Value<string>(), Is.EqualTo(local.Id));
                    Assert.That(payload["label"].Value<string>(), Is.EqualTo("local"));
                });
            }
            finally
            {
                foreach (var clone in clones)
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
            => AssertTheLastChangesGoOutOn(ticker => ticker.SendMessage("OnApplicationQuit", SendMessageOptions.DontRequireReceiver));

        /// <summary>
        /// On Android, and so on Quest, Unity may never call OnApplicationQuit: taking the headset
        /// off or leaving the app pauses it, and the system may end it without another frame.
        /// </summary>
        [UnityTest]
        public IEnumerator WhatTheLimitHoldsIsSentWhenTheAppIsPaused()
            => AssertTheLastChangesGoOutOn(ticker => ticker.SendMessage("OnApplicationPause", true, SendMessageOptions.DontRequireReceiver));

        /// <summary>Losing focus is the exit Unity's documentation says to rely on for Android.</summary>
        [UnityTest]
        public IEnumerator WhatTheLimitHoldsIsSentWhenTheAppLosesFocus()
            => AssertTheLastChangesGoOutOn(ticker => ticker.SendMessage("OnApplicationFocus", false, SendMessageOptions.DontRequireReceiver));

        /// <summary>
        /// Holds one change back, makes another that no poll has seen yet - as a script running
        /// after the ticker in the app's last frame does - and expects both at once, as one update,
        /// when <paramref name="stop"/> tells the ticker that the app is going away.
        /// </summary>
        private IEnumerator AssertTheLastChangesGoOutOn(Action<Component> stop)
        {
            var model = SpawnConfigured<E2ESyncModel>("last-changes", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            try
            {
                model.Label = "sent";
                yield return Peer.Expect(Channel, "model::update");

                model.Label = "held";
                yield return null;
                yield return null;

                model.Count = 5;
                stop(Resources.FindObjectsOfTypeAll<SyncTicker>().Single());

                yield return Peer.Expect(Channel, "model::update", frame =>
                {
                    var payload = TcpPeer.Json(frame);
                    Assert.That(payload["label"]?.Value<string>(), Is.EqualTo("held"), $"The held change did not go out at once: {payload}");
                    Assert.That(payload["_count"]?.Value<int>(), Is.EqualTo(5), $"The change made in the last frame did not go out with it: {payload}");
                }, timeoutSeconds: 0.5f);
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

        /// <summary>
        /// Deleted by another client while the limit holds an update for it, the object is gone
        /// here a moment later - but until then it used to be driven by the ticker. An update sent
        /// in that moment, held or new, reaches the server after the delete and creates the model
        /// afresh there, and every other client's manager builds a ghost of it that nobody will
        /// ever delete again.
        /// </summary>
        /// <remarks>
        /// Both only happen in that moment by chance, so a second delete listener stages them as
        /// the delete is delivered: it lifts the limit - as the interval running out in that frame
        /// does - and changes the object, as a script moving it in that frame does.
        /// </remarks>
        [UnityTest]
        public IEnumerator ADeleteFromAnotherClientIsNotUndoneByWhatTheLimitHolds()
        {
            var model = SpawnConfigured<E2ESyncModel>("deleted-elsewhere-while-held", _ => { });
            yield return LetInitialStateArrive();

            var id = model.Id;
            Action<JObject> inTheSameFrame = deleted =>
            {
                if (deleted["id"]?.Value<string>() != id)
                    return;

                SyncSettings.MaxSendRate = 0;
                model.Count = 42;
            };

            Sync.AddModelDeleteListener(Channel, inTheSameFrame);
            SyncSettings.MaxSendRate = 1;
            try
            {
                model.Label = "sent";
                yield return Peer.Expect(Channel, "model::update", timeoutSeconds: 0.5f);

                model.Label = "held";
                yield return null;
                yield return null;

                Peer.Send(Channel, "model::delete", new JObject { { "id", id } });
                yield return E2EServer.WaitUntil(() => model == null, "The model deleted by the peer was never destroyed");
                yield return E2EServer.Settle(0.5f);

                // What the server holds for that id now: nothing but the id, which is its answer
                // for a model it does not know - unless the held update has brought it back.
                Peer.Send(Channel, "model::request", new JObject { { "id", id } });
                yield return Peer.Expect(Channel, "model::update", frame =>
                {
                    var payload = (JObject)TcpPeer.Json(frame);
                    Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
                    Assert.That(payload.Properties().Select(p => p.Name).ToArray(), Is.EqualTo(new[] { "id" }),
                        $"The model the peer deleted is back on the server: {payload.ToString(Newtonsoft.Json.Formatting.None)}");
                });
            }
            finally
            {
                Sync.RemoveModelDeleteListener(Channel, inTheSameFrame);
                SyncSettings.ResetMaxSendRate();
            }
        }

        private static E2ESyncModel[] Instances(string id)
            => UnityCompat.FindAll<E2ESyncModel>(FindObjectsInactive.Include)
                .Where(m => m.Id == id)
                .ToArray();

        private static E2EFragileModel[] FragileInstances(string id)
            => UnityCompat.FindAll<E2EFragileModel>(FindObjectsInactive.Include)
                .Where(m => m.Id == id)
                .ToArray();
    }
}
