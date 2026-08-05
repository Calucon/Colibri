using System;
using System.Collections;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using ColibriStore = HCIKonstanz.Colibri.Store.Store;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>Anything the Store round-trips has to survive JSON in both directions.</summary>
    public class StoredThing
    {
        public string Name { get; set; }
        public int Count { get; set; }
    }

    /// <summary>
    /// The Store is the one part of Colibri that does not use the binary protocol at all - it is
    /// plain REST over the web port, which is why a wrong address failed so differently there.
    /// </summary>
    public class StoreTests : ColibriE2EFixture
    {
        [UnityTest]
        public IEnumerator SavesAndReadsBackAnObject()
        {
            var key = $"e2e-{Guid.NewGuid():N}";

            var put = ColibriStore.Put(key, new StoredThing { Name = "colibri", Count = 3 });
            yield return E2EServer.Await(put, "Store.Put never completed", 20f);
            Assert.That(put.Result, Is.True, "Store.Put reported failure");

            var get = ColibriStore.Get<StoredThing>(key);
            yield return E2EServer.Await(get, "Store.Get never completed", 20f);

            Assert.That(get.Result, Is.Not.Null, "Store.Get returned nothing for a key it had just written");
            Assert.That(get.Result.Name, Is.EqualTo("colibri"));
            Assert.That(get.Result.Count, Is.EqualTo(3));

            var delete = ColibriStore.Delete(key);
            yield return E2EServer.Await(delete, "Store.Delete never completed", 20f);
            Assert.That(delete.Result, Is.True, "Store.Delete reported failure");
        }

        /// <summary>
        /// UnityWebRequest defaults to no timeout at all, so a wrong server address used to leave
        /// the call outstanding forever: no result, no error, nothing in the console, and a student
        /// with no way to tell a slow server from a typo.
        /// </summary>
        [UnityTest]
        public IEnumerator GivesUpAndSaysSoWhenTheServerIsNotThere()
        {
            var config = ColibriConfig.Load();
            var realPort = config.WebServerPort;

            // Only the web port, so the binary connection this fixture depends on is untouched.
            config.WebServerPort = 9099;
            try
            {
                LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load "));

                var get = ColibriStore.Get<StoredThing>("does-not-matter");
                yield return E2EServer.Await(get, "Store.Get hung against an unreachable server", 20f);

                Assert.That(get.Result, Is.Null);
            }
            finally
            {
                config.WebServerPort = realPort;
            }
        }
    }
}
