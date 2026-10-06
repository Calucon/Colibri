using System;
using System.Collections;
using System.Linq;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The zero-code component: drop <c>SyncTransform</c> on an object and it follows its twin on
    /// every other client. Both directions, and the per-field switches that decide what is worth
    /// putting on the wire at all.
    /// </summary>
    public class SyncTransformTests : ColibriE2EFixture
    {
        private const string Channel = "synctransform";

        private static IEnumerator LetInitialStateArrive() => E2EServer.Settle(1.5f);

        [UnityTest]
        public IEnumerator AMoveReachesTheOtherClient()
        {
            var sync = SpawnConfigured<SyncTransform>("cube", _ => { });
            yield return LetInitialStateArrive();

            sync.transform.position = new Vector3(1f, 2f, 3f);

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(sync.Id));
                Assert.That(payload["position"].ToString(Newtonsoft.Json.Formatting.None), Is.EqualTo("[1.0,2.0,3.0]"));
            });
        }

        /// <summary>
        /// Turning a field off has to keep it off the wire even while it is changing locally.
        /// Otherwise the switches are decoration and every object costs the full transform.
        /// </summary>
        [UnityTest]
        public IEnumerator TheFieldsThatAreSwitchedOffAreNotSentEvenWhenTheyChange()
        {
            var sync = SpawnConfigured<SyncTransform>("position-only", s =>
            {
                s.SyncActive = false;
                s.SyncRotation = false;
                s.SyncScale = false;
            });
            yield return LetInitialStateArrive();

            sync.transform.position = new Vector3(1f, 2f, 3f);
            sync.transform.rotation = Quaternion.Euler(0f, 90f, 0f);
            sync.transform.localScale = new Vector3(2f, 2f, 2f);

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                var members = payload.Properties().Select(p => p.Name).OrderBy(n => n).ToArray();

                Assert.That(members, Is.EqualTo(new[] { "id", "position" }),
                    $"Rotation and scale changed too, but only position was meant to travel. Sent: {string.Join(", ", members)}");
            });
        }

        [UnityTest]
        public IEnumerator AnUnchangedTransformSendsNothingAtAll()
        {
            SpawnConfigured<SyncTransform>("still", _ => { });
            yield return LetInitialStateArrive();

            // Nothing was touched, so nothing should ever have gone out - not at startup either.
            // The initial state exchange is between the object and the server alone; the peer is
            // only told about changes.
            yield return Peer.ExpectNothing(Channel, 2f);
        }

        /// <summary>
        /// The other half, and the one the manual verification never confirmed: an update from
        /// another client actually moves the object.
        /// </summary>
        [UnityTest]
        public IEnumerator AMoveFromAnotherClientMovesTheObject()
        {
            var sync = SpawnConfigured<SyncTransform>("follower", _ => { });
            yield return LetInitialStateArrive();

            Peer.Send(Channel, "model::update", new JObject
            {
                { "id", sync.Id },
                { "position", new JArray(4f, 5f, 6f) }
            });

            yield return E2EServer.WaitUntil(
                () => sync.transform.position == new Vector3(4f, 5f, 6f),
                $"The object never moved; it is at {sync.transform.position}");
        }


        /*
         *  Active state. Deactivating an object has to hide its copies everywhere else, and
         *  reactivating it has to bring them back. It never did: the poll skipped inactive
         *  objects, so `false` was never seen. And whatever tears an object down - Destroy, a
         *  scene unload, the end of Play mode - must not be mistaken for a deactivation on the
         *  way out.
         */

        [UnityTest]
        public IEnumerator DeactivatingTheObjectHidesItOnTheOtherClientAndReactivatingItShowsIt()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-and-back", _ => { });
            yield return LetInitialStateArrive();

            sync.gameObject.SetActive(false);

            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, false));

            sync.gameObject.SetActive(true);

            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, true));
            yield return Peer.ExpectNothing(Channel);
        }

        /// <summary>
        /// The send-rate limit holds back the moves that follow one another, but not this: hiding
        /// an object is often the last thing that happens to it, and it goes out at once, carrying
        /// the move that was being held.
        /// </summary>
        [UnityTest]
        public IEnumerator HidingAMovingObjectIsNotHeldBackByTheSendRateLimit()
        {
            var sync = SpawnConfigured<SyncTransform>("moved-then-hidden", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            try
            {
                sync.transform.position = new Vector3(1f, 0f, 0f);
                yield return Peer.Expect(Channel, "model::update", timeoutSeconds: 0.5f);

                sync.transform.position = new Vector3(2f, 0f, 0f);
                yield return null;
                sync.gameObject.SetActive(false);

                yield return Peer.Expect(Channel, "model::update", frame =>
                {
                    AssertActive(frame, sync.Id, false);
                    Assert.That(TcpPeer.Json(frame)["position"].ToString(Newtonsoft.Json.Formatting.None), Is.EqualTo("[2.0,0.0,0.0]"));
                }, timeoutSeconds: 0.5f);
            }
            finally
            {
                SyncSettings.ResetMaxSendRate();
            }
        }

        /// <summary>
        /// Switching the component off stops it syncing; it does not mean the object has gone.
        /// </summary>
        [UnityTest]
        public IEnumerator DisablingOnlyTheComponentDoesNotHideTheObjectElsewhere()
        {
            var sync = SpawnConfigured<SyncTransform>("component-off", _ => { });
            yield return LetInitialStateArrive();

            sync.enabled = false;
            yield return Peer.ExpectNothing(Channel, 1.5f);

            sync.enabled = true;
            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        [UnityTest]
        public IEnumerator AnotherClientHidingAndShowingTheObjectIsAppliedHereAndNotEchoed()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-remotely", _ => { });
            yield return LetInitialStateArrive();

            Peer.Send(Channel, "model::update", new JObject { { "id", sync.Id }, { "active", false } });
            yield return E2EServer.WaitUntil(() => !sync.gameObject.activeSelf,
                "The peer deactivated the object, but it is still active here");
            yield return Peer.ExpectNothing(Channel);

            Peer.Send(Channel, "model::update", new JObject { { "id", sync.Id }, { "active", true } });
            yield return E2EServer.WaitUntil(() => sync.gameObject.activeSelf,
                "The peer reactivated the object, but it is still inactive here");
            yield return Peer.ExpectNothing(Channel);

            // And this client can still hide it itself afterwards.
            sync.gameObject.SetActive(false);
            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, false));
        }

        [UnityTest]
        public IEnumerator DestroyingTheObjectDeletesItWithoutDeactivatingItFirst()
        {
            var sync = SpawnConfigured<SyncTransform>("destroyed", _ => { });
            yield return LetInitialStateArrive();

            var id = sync.Id;
            Object.Destroy(sync.gameObject);

            yield return Peer.Expect(Channel, "model::delete",
                frame => Assert.That(TcpPeer.Json(frame)["id"].Value<string>(), Is.EqualTo(id)));

            // An active:false sent on the way out would have arrived before the delete and still
            // be waiting here.
            yield return Peer.ExpectNothing(Channel);
        }

        [UnityTest]
        public IEnumerator UnloadingTheSceneDeletesTheObjectWithoutDeactivatingItFirst()
        {
            var scene = SceneManager.CreateScene($"colibri-unload-{Guid.NewGuid():N}");
            var sync = SpawnConfigured<SyncTransform>("unloaded-with-its-scene", _ => { });
            SceneManager.MoveGameObjectToScene(sync.gameObject, scene);
            yield return LetInitialStateArrive();

            var id = sync.Id;
            yield return SceneManager.UnloadSceneAsync(scene);

            yield return Peer.Expect(Channel, "model::delete",
                frame => Assert.That(TcpPeer.Json(frame)["id"].Value<string>(), Is.EqualTo(id)));
            yield return Peer.ExpectNothing(Channel);
        }


        /*
         *  Objects another client created, built here by a SyncTransformManager from a template
         *  that is switched off - the usual way to keep a template in the scene without it being
         *  a synced object itself. The clone starts out switched off as well, and used to stay
         *  that way: it never ran Awake, never registered for its own updates, and an object that
         *  arrived hidden could never be shown again.
         */

        [UnityTest]
        public IEnumerator AnObjectHiddenElsewhereIsBuiltFromAnInactiveTemplateAndShownWhenItReappears()
        {
            yield return SpawnManagerWithInactiveTemplate();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject
            {
                { "id", id },
                { "active", false },
                { "position", new JArray(1f, 2f, 3f) }
            });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the object '{id}' it was told about");

            var clone = Instances(id).Single();
            try
            {
                Assert.That(clone.gameObject.activeSelf, Is.False, "The object is hidden on the client it came from");
                Assert.That(clone.transform.position, Is.EqualTo(new Vector3(1f, 2f, 3f)));

                Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "active", true } });
                yield return E2EServer.WaitUntil(() => clone.gameObject.activeSelf,
                    "The peer showed the object again, but it is still hidden here");

                // Applying either state must not send it back.
                yield return Peer.ExpectNothing(Channel);
            }
            finally
            {
                Object.Destroy(clone.gameObject);
            }
        }

        [UnityTest]
        public IEnumerator AVisibleObjectIsBuiltFromAnInactiveTemplateAsVisibleAndFollowsItsMoves()
        {
            yield return SpawnManagerWithInactiveTemplate();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "position", new JArray(1f, 2f, 3f) } });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the object '{id}' it was told about");

            var clone = Instances(id).Single();
            try
            {
                Assert.That(clone.gameObject.activeSelf, Is.True, "The clone of an inactive template stayed inactive");
                Assert.That(clone.transform.position, Is.EqualTo(new Vector3(1f, 2f, 3f)));

                Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "position", new JArray(4f, 5f, 6f) } });
                yield return E2EServer.WaitUntil(() => clone.transform.position == new Vector3(4f, 5f, 6f),
                    $"The clone never moved; it is at {clone.transform.position}");

                yield return Peer.ExpectNothing(Channel);
            }
            finally
            {
                Object.Destroy(clone.gameObject);
            }
        }

        private IEnumerator SpawnManagerWithInactiveTemplate()
        {
            var templateObject = Spawn("inactive-transform-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<SyncTransform>();

            var manager = Spawn<SyncTransformManager>("transform-manager");
            manager.Template = template;

            // Start is where the manager subscribes; nothing before it runs would be seen.
            yield return null;
            yield return LetInitialStateArrive();
        }

        private static SyncTransform[] Instances(string id)
            => Object.FindObjectsByType<SyncTransform>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .Where(s => s.Id == id)
                .ToArray();


        /*
         *  Quitting. Leaving Play mode or the app tears every object down, and that must delete
         *  nothing on the server: the object is meant to outlive this client. An active object
         *  hears about it through OnApplicationQuit, but Unity never sends that to an inactive
         *  one - and a synced object is inactive whenever this client or another one has hidden
         *  it. Such an object used to delete itself, and every other client's copy with it.
         */

        [UnityTest]
        public IEnumerator AnObjectHiddenHereIsNotDeletedEverywhereWhenThisClientQuits()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-then-quit", _ => { });
            yield return LetInitialStateArrive();

            sync.gameObject.SetActive(false);
            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, false));

            yield return DestroyWhileQuitting(sync);

            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        [UnityTest]
        public IEnumerator AnObjectHiddenByAnotherClientIsNotDeletedEverywhereWhenThisClientQuits()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-remotely-then-quit", _ => { });
            yield return LetInitialStateArrive();

            Peer.Send(Channel, "model::update", new JObject { { "id", sync.Id }, { "active", false } });
            yield return E2EServer.WaitUntil(() => !sync.gameObject.activeSelf,
                "The peer deactivated the object, but it is still active here");

            yield return DestroyWhileQuitting(sync);

            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        /// <summary>
        /// Stands in for the end of Play mode: Application.quitting has been raised, then the
        /// object is destroyed. A test cannot send OnApplicationQuit, and the inactive objects
        /// above would not receive it anyway.
        /// </summary>
        private static IEnumerator DestroyWhileQuitting(Component component)
        {
            SingletonLifetime.IsQuitting = true;
            try
            {
                Object.Destroy(component.gameObject);

                // Destruction happens at the end of the frame; OnDestroy has run by the next one.
                yield return null;
            }
            finally
            {
                // Every later test needs a live application again.
                SingletonLifetime.IsQuitting = false;
            }
        }

        private static void AssertActive(Networking.Protocol.DecodedFrame frame, string id, bool expected)
        {
            var payload = (JObject)TcpPeer.Json(frame);

            Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
            Assert.That(payload.ContainsKey("active"), Is.True, $"Expected the active state, got {payload}");
            Assert.That(payload["active"].Value<bool>(), Is.EqualTo(expected));
        }
    }
}
