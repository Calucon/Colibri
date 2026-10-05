using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// What happens to one bad message on its way from the socket to user code.
    ///
    /// Every received message is delivered from one loop in <c>WebServerConnection.Update</c>, so an
    /// exception anywhere along the way - a payload that is not the type its command names, or a
    /// listener with a bug in it - used to skip every other listener of that message and push every
    /// message queued behind it to the next frame. Each is now one log line naming the channel and
    /// command, and nothing else is affected.
    /// </summary>
    public class MessageDispatchTests
    {
        private readonly List<Action> _cleanup = new List<Action>();
        private static int _channelCounter;

        [SetUp]
        public void Reset() => ChannelListenerRegistry.Clear();

        [TearDown]
        public void Cleanup()
        {
            foreach (var undo in _cleanup)
                undo();
            _cleanup.Clear();

            ChannelListenerRegistry.Clear();

            // Registering a listener creates the connection singleton, which in edit mode is an
            // inert component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in Object.FindObjectsByType<WebServerConnection>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                Object.DestroyImmediate(connection.gameObject);
        }

        private static string NewChannel() => $"dispatch-test-{++_channelCounter}";


        /*
         *  Payloads that cannot be read as the type their command names
         */

        [TestCase("broadcast::bool", "null")]
        [TestCase("broadcast::bool", "\"maybe\"")]
        [TestCase("broadcast::bool", "[true]")]
        [TestCase("broadcast::bool", "{\"a\":true}")]
        public void AMalformedBoolIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<bool>(command, payload, "bool", "true", true);

        [TestCase("broadcast::int", "null")]
        [TestCase("broadcast::int", "\"five\"")]
        [TestCase("broadcast::int", "[5]")]
        [TestCase("broadcast::int", "{\"a\":5}")]
        [TestCase("broadcast::int", "1e40")]
        public void AMalformedIntIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<int>(command, payload, "int", "5", 5);

        [TestCase("broadcast::float", "null")]
        [TestCase("broadcast::float", "\"fast\"")]
        [TestCase("broadcast::float", "[1.5]")]
        [TestCase("broadcast::float", "{\"a\":1.5}")]
        public void AMalformedFloatIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<float>(command, payload, "float", "1.5", 1.5f);

        [TestCase("broadcast::string", "[\"a\"]")]
        [TestCase("broadcast::string", "{\"a\":\"b\"}")]
        public void AMalformedStringIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<string>(command, payload, "string", "\"ok\"", "ok");

        [TestCase("broadcast::bool[]", "null")]
        [TestCase("broadcast::bool[]", "true")]
        [TestCase("broadcast::bool[]", "[true,\"maybe\"]")]
        [TestCase("broadcast::bool[]", "[true,null]")]
        public void AMalformedBoolArrayIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<bool[]>(command, payload, "bool[]", "[true,false]", new[] { true, false });

        [TestCase("broadcast::int[]", "null")]
        [TestCase("broadcast::int[]", "5")]
        [TestCase("broadcast::int[]", "\"1,2\"")]
        [TestCase("broadcast::int[]", "{\"a\":1}")]
        [TestCase("broadcast::int[]", "[1,\"x\"]")]
        [TestCase("broadcast::int[]", "[1,null]")]
        [TestCase("broadcast::int[]", "[[1]]")]
        public void AMalformedIntArrayIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<int[]>(command, payload, "int[]", "[1,2]", new[] { 1, 2 });

        [TestCase("broadcast::float[]", "null")]
        [TestCase("broadcast::float[]", "1.5")]
        [TestCase("broadcast::float[]", "[1.5,\"x\"]")]
        [TestCase("broadcast::float[]", "[{}]")]
        public void AMalformedFloatArrayIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<float[]>(command, payload, "float[]", "[1.5,2.5]", new[] { 1.5f, 2.5f });

        [TestCase("broadcast::string[]", "null")]
        [TestCase("broadcast::string[]", "\"a\"")]
        [TestCase("broadcast::string[]", "[\"a\",{}]")]
        [TestCase("broadcast::string[]", "[[\"a\"]]")]
        public void AMalformedStringArrayIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<string[]>(command, payload, "string[]", "[\"a\",\"b\"]", new[] { "a", "b" });

        /// <summary>
        /// The vector arrays read their elements with the same forgiving conversions as a single
        /// vector, but the outer shape still has to be an array.
        /// </summary>
        [TestCase("broadcast::vector3[]", "null")]
        [TestCase("broadcast::vector3[]", "{\"x\":1}")]
        public void AVector3ArrayThatIsNotAnArrayIsReportedOnceAndNotDelivered(string command, string payload)
            => AssertMalformedIsReportedOnce<Vector3[]>(command, payload, "Vector3[]", "[[1,2,3]]", new[] { new Vector3(1f, 2f, 3f) });

        /// <summary>
        /// Leniency that worked before keeps working: only what used to throw is reported.
        /// </summary>
        [Test]
        public void AlreadyAcceptedSpellingsStillArrive()
        {
            AssertDelivered<int>("broadcast::int", "\"5\"", 5);
            AssertDelivered<bool>("broadcast::bool", "1", true);
            AssertDelivered<float>("broadcast::float", "2", 2f);
            AssertDelivered<string>("broadcast::string", "5", "5");
            AssertDelivered<int[]>("broadcast::int[]", "[]", new int[0]);

            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// A malformed value on a channel nothing here listens to is somebody else's traffic - every
        /// client sees every channel its app uses - so it is not read, and not reported.
        /// </summary>
        [Test]
        public void AMalformedValueOnAChannelNobodyListensToIsNotReported()
        {
            Sync.OnServerMessage(NewChannel(), "broadcast::int", JToken.Parse("\"five\""));

            LogAssert.NoUnexpectedReceived();
        }


        /*
         *  Listeners that throw
         */

        [Test]
        public void AThrowingListenerDoesNotStopTheOtherListeners()
        {
            var channel = NewChannel();
            var received = new List<int>();

            Register<int>(channel, _ => throw new InvalidOperationException("listener bug"));
            Register<int>(channel, value => received.Add(value));

            ExpectListenerError("broadcast::int", channel);
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            ExpectListenerError("broadcast::int", channel);
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(2));

            Assert.That(received, Is.EqualTo(new[] { 1, 2 }),
                "A listener registered after the throwing one never got the message");
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AThrowingModelListenerDoesNotStopTheOtherModelListeners()
        {
            var channel = NewChannel();
            var received = 0;

            Action<JObject> throwing = _ => throw new InvalidOperationException("listener bug");
            Action<JObject> counting = _ => received++;

            Sync.AddModelDeleteListener(channel, throwing);
            Sync.AddModelDeleteListener(channel, counting);
            _cleanup.Add(() => Sync.RemoveModelDeleteListener(channel, throwing));
            _cleanup.Add(() => Sync.RemoveModelDeleteListener(channel, counting));

            ExpectListenerError("model::delete", channel);
            Sync.OnServerMessage(channel, "model::delete", new JObject { { "id", "a" } });

            Assert.That(received, Is.EqualTo(1));
            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// One level up: a handler subscribed to the connection itself. The connection delivers the
        /// whole frame's messages in one loop, so a throw here used to postpone everything behind it.
        /// </summary>
        [Test]
        public void AThrowingConnectionHandlerDoesNotStopTheOtherHandlersOrTheMessagesBehindIt()
        {
            var connection = new GameObject("dispatch-test-connection").AddComponent<WebServerConnection>();
            var received = new List<string>();

            connection.OnMessageReceived += (channel, command, payload) => throw new InvalidOperationException("handler bug");
            connection.OnMessageReceived += (channel, command, payload) => received.Add((string)payload);

            connection.EnqueueReceived("a", "broadcast::string", new JValue("first"));
            connection.EnqueueReceived("b", "broadcast::string", new JValue("second"));
            connection.EnqueueReceived("c", "broadcast::string", new JValue("third"));

            foreach (var channel in new[] { "a", "b", "c" })
            {
                LogAssert.Expect(LogType.Error, new Regex(
                    $"^Colibri: a handler of OnMessageReceived threw an exception while handling broadcast::string on channel '{channel}'\\."));
            }

            connection.DeliverReceivedMessages();

            Assert.That(received, Is.EqualTo(new[] { "first", "second", "third" }),
                "A throwing handler kept the other handler, or the messages behind it, from being delivered this frame");
            LogAssert.NoUnexpectedReceived();
        }


        /*
         *  Helpers
         */

        private void Register<T>(string channel, Action<T> listener)
        {
            Sync.Receive(channel, listener);
            _cleanup.Add(() => Sync.Unregister(channel, listener));
        }

        /// <summary>
        /// Delivers the malformed payload, then a good one on the same channel: exactly one warning
        /// for the first, which never reaches the listener, and the second arrives as normal.
        /// </summary>
        private void AssertMalformedIsReportedOnce<T>(string command, string malformed, string typeName, string wellFormed, T expected)
        {
            var channel = NewChannel();
            var received = new List<T>();
            Register<T>(channel, value => received.Add(value));

            LogAssert.Expect(LogType.Warning, new Regex(
                $"^Colibri: received a {Regex.Escape(command)} on channel '{channel}' that cannot be read as {Regex.Escape(typeName)}: "));

            Assert.DoesNotThrow(() => Sync.OnServerMessage(channel, command, JToken.Parse(malformed)));
            Assert.That(received, Is.Empty, $"'{malformed}' was delivered as if it were a {typeName}");

            Sync.OnServerMessage(channel, command, JToken.Parse(wellFormed));
            Assert.That(received, Is.EqualTo(new[] { expected }), "The well-formed message behind it was not delivered");

            // Exactly one line: not a second warning, and no type-mismatch warning on top.
            LogAssert.NoUnexpectedReceived();
        }

        private void AssertDelivered<T>(string command, string payload, T expected)
        {
            var channel = NewChannel();
            var received = new List<T>();
            Register<T>(channel, value => received.Add(value));

            Sync.OnServerMessage(channel, command, JToken.Parse(payload));

            Assert.That(received, Is.EqualTo(new[] { expected }), $"'{payload}' on {command}");
        }

        private static void ExpectListenerError(string command, string channel)
            => LogAssert.Expect(LogType.Error, new Regex(
                $"^Colibri: a listener for {Regex.Escape(command)} on channel '{channel}' threw an exception\\."));
    }
}
