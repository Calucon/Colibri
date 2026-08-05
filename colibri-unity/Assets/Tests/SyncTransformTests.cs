using System.Collections;
using System.Linq;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

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
    }
}
