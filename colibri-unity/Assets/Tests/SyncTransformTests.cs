using System;
using System.Collections;
using System.Linq;
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

        private static void AssertActive(Networking.Protocol.DecodedFrame frame, string id, bool expected)
        {
            var payload = (JObject)TcpPeer.Json(frame);

            Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
            Assert.That(payload.ContainsKey("active"), Is.True, $"Expected the active state, got {payload}");
            Assert.That(payload["active"].Value<bool>(), Is.EqualTo(expected));
        }
    }
}
