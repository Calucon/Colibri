using System.Collections.Generic;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using ColibriStore = HCIKonstanz.Colibri.Store.Store;
using Placement = HCIKonstanz.Colibri.Tests.ColibriJsonTests.Placement;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// What the Store makes of a value on the way to the server and back, without the server.
    /// A value Newtonsoft could not convert threw a JsonException out of Put, or out of Get after
    /// the request had succeeded - past the await, into code written against a Store that logs
    /// what went wrong and answers false or default.
    /// </summary>
    public class StoreJsonTests
    {
        [Test]
        public void AClassWithUnityTypesRoundTrips()
        {
            Assert.That(ColibriStore.TryToJson("placement", ColibriJsonTests.Sample(), out var json), Is.True);
            Assert.That(ColibriStore.TryFromJson<Placement>("placement", json, out var loaded), Is.True);

            ColibriJsonTests.AssertSameAsSample(loaded);
        }

        [Test]
        public void SomethingThatIsNotJsonLoadsAsDefaultAndSaysSo()
        {
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load \"broken\" as Placement - "));

            Assert.That(ColibriStore.TryFromJson<Placement>("broken", "{ \"Name\": ", out var loaded), Is.False);
            Assert.That(loaded, Is.Null);
        }

        [Test]
        public void AValueThatDoesNotFitTheTypeLoadsAsDefaultAndSaysSo()
        {
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load \"scores\" as List<Int32> - "));

            Assert.That(ColibriStore.TryFromJson<List<int>>("scores", "{ \"not\": \"a list\" }", out var loaded), Is.False);
            Assert.That(loaded, Is.Null);
        }

        [Test]
        public void AVectorOfTheWrongShapeLoadsAsDefaultAndSaysWhere()
        {
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load \"placement\" as Placement - .*'\\[1,2\\]' at 'Position' is not a Vector3"));

            Assert.That(ColibriStore.TryFromJson<Placement>("placement", "{ \"Position\": [1, 2] }", out var loaded), Is.False);
            Assert.That(loaded, Is.Null);
        }

        private class Loop
        {
            public Loop Next;
        }

        [Test]
        public void AValueThatCannotBeConvertedIsNotSavedAndSaysSo()
        {
            var loop = new Loop();
            loop.Next = loop;

            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not save \"loop\" - Loop cannot be converted to JSON: "));

            Assert.That(ColibriStore.TryToJson("loop", loop, out var json), Is.False);
            Assert.That(json, Is.Null);
        }
    }
}
