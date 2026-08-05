using System.Collections;
using System.Linq;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The machinery behind the sync loop, which has no public surface and therefore no other way
    /// of being checked.
    ///
    /// The 2.0.0 performance claim is that synchronization costs one <c>Update</c> and one
    /// <c>LateUpdate</c> for the whole application, no matter how many objects are synced. That
    /// held right up until the ticker started surviving Play mode: seven of them had accumulated,
    /// all enabled, all driving the same static list, so the seventh session sent every update
    /// seven times.
    /// </summary>
    public class LifecycleTests : ColibriE2EFixture
    {
        [UnityTest]
        public IEnumerator ThereIsExactlyOneTickerHoweverManyObjectsAreSynced()
        {
            SpawnConfigured<E2ESyncModel>("a", _ => { });
            SpawnConfigured<E2ESyncModel>("b", _ => { });
            SpawnConfigured<SyncTransform>("c", _ => { });
            yield return null;

            var tickers = Resources.FindObjectsOfTypeAll<SyncTicker>();

            Assert.That(tickers.Length, Is.EqualTo(1),
                $"Expected one sync ticker, found {tickers.Length}");
        }

        /// <summary>
        /// <c>HideFlags.DontSave</c> does not only keep an object out of the saved scene - it also
        /// exempts it from being destroyed when Play mode ends. That is what left one ticker behind
        /// per session. The flag must stay off; <c>DontDestroyOnLoad</c> alone is what is wanted.
        /// </summary>
        [UnityTest]
        public IEnumerator TheTickerIsNotExemptFromPlayModeTeardown()
        {
            SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return null;

            var ticker = Resources.FindObjectsOfTypeAll<SyncTicker>().Single();

            Assert.That(ticker.gameObject.hideFlags, Is.EqualTo(HideFlags.None),
                "The ticker carries hide flags again, so it will survive Play mode and the next "
                + "session will tick everything twice");
        }

        [UnityTest]
        public IEnumerator EachSyncedObjectIsDrivenExactlyOnce()
        {
            var before = SyncTicker.RegisteredCount;

            SpawnConfigured<E2ESyncModel>("a", _ => { });
            SpawnConfigured<E2ESyncModel>("b", _ => { });
            yield return null;

            Assert.That(SyncTicker.RegisteredCount, Is.EqualTo(before + 2));
        }

        [UnityTest]
        public IEnumerator ADestroyedObjectStopsBeingDriven()
        {
            var before = SyncTicker.RegisteredCount;
            var model = SpawnConfigured<E2ESyncModel>("temporary", _ => { });
            yield return null;

            Assert.That(SyncTicker.RegisteredCount, Is.EqualTo(before + 1));

            Object.DestroyImmediate(model.gameObject);

            // Deregistering clears the slot; LateUpdate compacts the list on the next frame.
            yield return null;
            yield return null;

            Assert.That(SyncTicker.RegisteredCount, Is.EqualTo(before),
                "A destroyed object is still registered with the ticker");
        }

        /// <summary>
        /// The connection is a singleton on purpose: one socket, one handshake, one client on the
        /// server's Clients page however many scenes and components ask for it.
        /// </summary>
        [UnityTest]
        public IEnumerator ThereIsExactlyOneConnection()
        {
            SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return null;

            var connections = Object.FindObjectsByType<Networking.WebServerConnection>(
                FindObjectsInactive.Include, FindObjectsSortMode.None);

            Assert.That(connections.Length, Is.EqualTo(1),
                $"Expected one WebServerConnection, found {connections.Length}");
        }
    }
}
