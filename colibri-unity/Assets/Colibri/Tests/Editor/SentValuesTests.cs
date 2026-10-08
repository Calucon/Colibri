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
         *  Which values count
         */

        /// <summary>
        /// The ninth value sent pushes out the first, which stays known as the value held before
        /// the oldest one kept. The tenth pushes that out for good.
        /// </summary>
        [Test]
        public void TheLastEightValuesAndTheOneBeforeThemAreKept()
        {
            var sent = Sent("v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8");

            Assert.That(sent.Judge(Wire("\"v1\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"v0\""), Always), Is.EqualTo(SentValues.Verdict.Lost),
                "The value pushed out of the ring was held before the oldest one kept");

            sent.Remember("v9", 109);
            Assert.That(sent.Judge(Wire("\"v1\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"v0\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "The tenth value sent should have pushed out the first for good");
        }

        /// <summary>
        /// Of what was sent before the window, only the newest counts: the value the member held
        /// when the window began. One sent before that cannot tell a lost change from another
        /// client's: set back to it by someone else, it would look as if everything after it had
        /// been lost.
        /// </summary>
        [Test]
        public void OfTheValuesSentBeforeTheWindowOnlyTheOneHeldWhenItBeganCounts()
        {
            var sent = Sent("a", "b", "c"); // at 100, 101 and 102

            Assert.That(sent.Judge(Wire("\"c\""), since: 101.5), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("\"b\""), since: 101.5), Is.EqualTo(SentValues.Verdict.Lost),
                "b was held when the window began, so c was lost");
            Assert.That(sent.Judge(Wire("\"a\""), since: 101.5), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "a had been replaced before the window began, so someone else set it");
            Assert.That(sent.Judge(Wire("\"c\""), since: 103), Is.EqualTo(SentValues.Verdict.NotSentRecently));
        }

        /// <summary>
        /// The case this is for: switched on long ago, switched off at the drop. Only the switch-off
        /// was sent in the window, and the answer holding the value from before it means it was lost.
        /// </summary>
        [Test]
        public void AfterAQuietSpellTheValueHeldWhenTheWindowBeganCounts()
        {
            var sent = new SentValues();
            sent.Remember(true, 100);
            sent.Remember(false, 200);

            Assert.That(sent.Judge(Wire("true"), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("false"), since: 190), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        /// <summary>
        /// Pushed out of the ring by values sent in the window, the value from before them still
        /// counts: it is what the member held when the window began, or one it sent in the window.
        /// </summary>
        [Test]
        public void AValuePushedOutOfTheRingCountsAsTheOneHeldBeforeTheOldestKept()
        {
            var sent = new SentValues();
            sent.Remember("held for a minute", 100);
            for (var i = 0; i < SentValues.Capacity; i++)
                sent.Remember($"moved {i}", 200 + i * 0.1);

            Assert.That(sent.Judge(Wire("\"held for a minute\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"moved 0\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"elsewhere\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// Once the member has taken a value from elsewhere, what it sent before says nothing about
        /// the server any more. The value it took does: the server held it, and holding it still
        /// after the member's next change means that change was lost.
        /// </summary>
        [Test]
        public void TakingAValueForgetsWhatWasSentAndKeepsTheValueTaken()
        {
            var sent = Sent("a", "b");
            sent.TookFromElsewhere(Wire("\"theirs\""));

            Assert.That(sent.Judge(Wire("\"theirs\""), Always), Is.EqualTo(SentValues.Verdict.NotSentRecently),
                "Nothing was sent since the value was taken");
            Assert.That(sent.HasSentSince(Always), Is.False);

            sent.Remember("mine", 200);
            Assert.That(sent.Judge(Wire("\"mine\""), since: 190), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("\"theirs\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost),
                "The value taken long before was still held when the window began");
            Assert.That(sent.Judge(Wire("\"a\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "A value sent before the one taken was set back by someone else");
            Assert.That(sent.Judge(Wire("\"b\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>A member that takes a value before it ever sends one has it all the same.</summary>
        [Test]
        public void AValueTakenBeforeTheFirstSendCounts()
        {
            var sent = new SentValues();
            sent.TookFromElsewhere(Wire("[0,-3,0]"));
            sent.Remember(new Vector3(7, 0, 7).ToJson(), 200);

            Assert.That(sent.Judge(Wire("[0,-3,0]"), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
        }

        /// <summary>
        /// The residual: a member whose very first value is lost has held nothing before it, so any
        /// answer is someone else's.
        /// </summary>
        [Test]
        public void BeforeTheFirstValueNothingWasHeld()
        {
            var sent = new SentValues();
            sent.Remember("first", 200);

            Assert.That(sent.Judge(Wire("\"\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// The trade-off, accepted: another client that sets the member back during the outage, to
        /// the value it held when the window began, looks exactly like the change after it being
        /// lost, and is undone.
        /// </summary>
        [Test]
        public void AnotherClientSettingTheValueHeldWhenTheWindowBeganBackLooksLikeALostChange()
        {
            var sent = new SentValues();
            sent.Remember(true, 100);
            sent.Remember(false, 200); // arrived; then another client set it back to true

            Assert.That(sent.Judge(Wire("true"), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
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
