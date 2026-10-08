using System.IO;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The decision behind the answers to the request a model makes again after a reconnect: the
    /// server's value for one member, held against the values that member sent recently. What the
    /// model then does with the verdict is in <see cref="ModelResyncTests"/>.
    /// </summary>
    public class SentValuesTests
    {
        private const double Always = double.NegativeInfinity;

        /// <summary>The values in the order they were sent, one second apart from 100 on.</summary>
        private static SentValues Sent(params JToken[] values)
        {
            var sent = new SentValues();
            for (var i = 0; i < values.Length; i++)
                sent.Remember(values[i], 100 + i);
            return sent;
        }

        /// <summary>
        /// A value as an answer from the server carries it: JSON the server wrote, read the way the
        /// connection reads every payload, with dates left as strings.
        /// </summary>
        private static JToken Wire(string json)
        {
            using (var reader = new JsonTextReader(new StringReader(json)) { DateParseHandling = DateParseHandling.None })
                return JToken.ReadFrom(reader);
        }


        /*
         *  The four cases
         */

        [Test]
        public void TheValueSentLastHasArrived()
            => Assert.That(Sent("a", "b").Judge(Wire("\"b\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));

        [Test]
        public void AValueSentBeforeTheLastOneMeansTheLastOneWasLost()
            => Assert.That(Sent("a", "b").Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.Lost));

        [Test]
        public void AValueThisMemberNeverSentWasSetByAnotherClient()
            => Assert.That(Sent("a", "b").Judge(Wire("\"c\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));

        [Test]
        public void AMemberThatSentNothingHasNothingToJudge()
            => Assert.That(new SentValues().Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.NotSentRecently));

        /// <summary>
        /// Back to an earlier value and sent again: the newest send decides. The server holding it
        /// is the server holding what this client shows, whichever of the sends arrived.
        /// </summary>
        [Test]
        public void AValueSentAgainLastCountsAsTheLastOne()
            => Assert.That(Sent("a", "b", "a").Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));


        /*
         *  Which sends count
         */

        [Test]
        public void OnlyTheLastEightValuesAreKept()
        {
            var sent = Sent("v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8");

            Assert.That(sent.Judge(Wire("\"v1\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"v0\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "The ninth value sent should have pushed out the first");
        }

        /// <summary>
        /// A value sent long before cannot tell a lost change from another client's: set back to
        /// it by someone else, it would look as if everything after it had been lost.
        /// </summary>
        [Test]
        public void ValuesSentBeforeTheWindowDoNotCount()
        {
            var sent = Sent("a", "b"); // at 100 and 101

            Assert.That(sent.Judge(Wire("\"a\""), since: 100.5), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "Only b was sent recently, so a was set by someone else");
            Assert.That(sent.Judge(Wire("\"b\""), since: 100.5), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("\"b\""), since: 102), Is.EqualTo(SentValues.Verdict.NotSentRecently));
        }

        [Test]
        public void ClearingForgetsEverySend()
        {
            var sent = Sent("a", "b");
            sent.Clear();

            Assert.That(sent.Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.NotSentRecently));
            Assert.That(sent.HasSentSince(Always), Is.False);
        }


        /*
         *  Values compared as they read on the wire
         */

        /// <summary>
        /// The values from the trace that found this: a Vector3 goes out as floats, [0.0,-3.0,0.0],
        /// and the server, which is JavaScript, writes the same numbers back as [0,-3,0].
        /// </summary>
        [Test]
        public void AVectorOfWholeNumbersEqualsTheServersIntegers()
        {
            var sent = Sent(new Vector3(0, -3, 0).ToJson(), new Vector3(7, 0, 7).ToJson());

            Assert.That(sent.Judge(Wire("[0,-3,0]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("[7,0,7]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        /// <summary>Held as the float 0.1f, sent as 0.1, which reads back as the double 0.1.</summary>
        [Test]
        public void AFloatEqualsTheDoubleItReadsBackAs()
        {
            var sent = Sent(new Vector3(0.1f, 0.25f, -1.5f).ToJson(), new Vector3(0.2f, 0.25f, -1.5f).ToJson());

            Assert.That(sent.Judge(Wire("[0.1,0.25,-1.5]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("[0.2,0.25,-1.5]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("[0.1,0.25,-1.6]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        [Test]
        public void AQuaternionIsComparedByItsNumbers()
        {
            var sent = Sent(Quaternion.identity.ToJson(), new Quaternion(0.5f, -0.5f, 0.5f, 0.5f).ToJson());

            Assert.That(sent.Judge(Wire("[0,0,0,1]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("[0.5,-0.5,0.5,0.5]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("[0.5,-0.5,0.5]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "An array of another length is another value");
        }

        /// <summary>
        /// Colibri sends a colour as its HTML string. colibri-web may send one as [r,g,b,a], which is
        /// another value on the wire, so another client's.
        /// </summary>
        [Test]
        public void AColourIsComparedAsTheStringItIsSentAs()
        {
            var red = new Color(1, 0, 0, 1);
            var blue = new Color(0, 0, 1, 1);
            var sent = Sent(red.ToJson(), blue.ToJson());

            Assert.That(sent.Judge(Wire($"\"{red.ToJson()}\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire($"\"{blue.ToJson()}\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("[1,0,0,1]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        [Test]
        public void ArraysAreComparedElementByElement()
        {
            var floats = Sent(new JArray(new[] { 1f, 2.5f }), new JArray(new[] { 1f, 3f }));
            Assert.That(floats.Judge(Wire("[1,2.5]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(floats.Judge(Wire("[1,3]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(floats.Judge(Wire("[2.5,1]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "Order matters");
            Assert.That(floats.Judge(Wire("[1,3,0]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "Length matters");

            var vectors = Sent(new JArray(new Vector3(1, 2, 3).ToJson(), new Vector3(0, 0, 0).ToJson()), new JArray());
            Assert.That(vectors.Judge(Wire("[[1,2,3],[0,0,0]]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(vectors.Judge(Wire("[]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));

            var strings = Sent(new JArray("a", "b"), new JArray("b", "a"));
            Assert.That(strings.Judge(Wire("[\"a\",\"b\"]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
        }

        [Test]
        public void AnObjectIsComparedByItsPropertiesInAnyOrder()
        {
            var sent = Sent(new JObject { { "a", 1 }, { "b", new JArray(2f) } }, new JObject { { "a", 2 } });

            Assert.That(sent.Judge(Wire("{\"b\":[2],\"a\":1}"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("{\"a\":1}"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "A property missing is another value");
            Assert.That(sent.Judge(Wire("{\"a\":2.0}"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        [Test]
        public void ScalarsAreComparedAsTheyReadOnTheWire()
        {
            Assert.That(Sent(2f, 2.5f).Judge(Wire("2"), Always), Is.EqualTo(SentValues.Verdict.Lost), "2.0 went out, 2 came back");
            Assert.That(Sent(1, 2).Judge(Wire("1"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(Sent(true, false).Judge(Wire("true"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(Sent(true, false).Judge(Wire("1"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "1 is not true on the wire");
            Assert.That(Sent("1", "2").Judge(Wire("1"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "Nor is it \"1\"");

            // A string that looks like a date stays a string on both sides.
            var stamp = "2026-10-08T12:00:00Z";
            Assert.That(Sent(stamp, "later").Judge(Wire($"\"{stamp}\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
        }
    }
}
