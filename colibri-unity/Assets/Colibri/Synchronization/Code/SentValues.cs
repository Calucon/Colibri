using System;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The values one [Sync] member of one object sent most recently, kept for a single decision:
    /// what to do with that member in the server's answers to the requests made again after a
    /// reconnect (see <see cref="Judge"/> and Sync.ReconnectRound).
    /// </summary>
    /// <remarks>
    /// <para>
    /// A change made the moment a headset's Wi-Fi drops is written into a connection that is
    /// already dead, and is lost: the client only notices about two seconds later, when the
    /// server's heartbeats stop. After the reconnect the server answers the request with the value
    /// from before that change, and applying it, as every update used to be applied, put the
    /// object back on the very client that had changed it, while every other client kept the old
    /// value as well - until the member changed again, which a released grab or a switched-off
    /// object never does.
    /// </para>
    /// <para>
    /// The answer alone cannot tell such a lost change from one another client made during the
    /// outage. What this client sent can: a value it sent before a newer one says the newer one
    /// never arrived, while a value it never sent was set by someone else.
    /// </para>
    /// </remarks>
    internal sealed class SentValues
    {
        internal enum Verdict
        {
            /// <summary>Nothing sent recently: the answer is applied, as any update is.</summary>
            NotSentRecently,

            /// <summary>The server holds the value sent last: it arrived, and there is nothing to do.</summary>
            Arrived,

            /// <summary>
            /// The server holds a value sent before the last one: what was sent after it never
            /// arrived. The local value stays, and goes out again.
            /// </summary>
            Lost,

            /// <summary>
            /// The server holds a value this object never sent recently: another client set it
            /// while this one was away, and the answer is applied.
            /// </summary>
            ChangedElsewhere,
        }

        /// <summary>The most values kept per member; the oldest goes first.</summary>
        internal const int Capacity = 8;

        private const double DefaultWindowSeconds = 10;

        /// <summary>
        /// How long before the connection was lost a value may have been sent and still count. A
        /// value sent long before cannot tell a lost change from another client's: a member that
        /// went from A to B a minute ago and that another client has set back to A during the
        /// outage would look as if B had been lost, and the other client's change would be undone.
        /// </summary>
        /// <remarks>
        /// Counted back from the moment this client noticed the outage, not from the answer, so a
        /// change lost at the drop is still recognised after an outage of any length. Settable only
        /// so the test suite can shorten it.
        /// </remarks>
        internal static double WindowSeconds = DefaultWindowSeconds;

        /// <summary>A setting changed by a test does not carry into the next Play session.</summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetWindow() => WindowSeconds = DefaultWindowSeconds;

        // A ring buffer: _newest is the slot of the latest value, the ones before it are older.
        private readonly JToken[] _values = new JToken[Capacity];
        private readonly double[] _times = new double[Capacity];
        private int _count;
        private int _newest = -1;

        /// <param name="value">
        /// The value as it went into the update. It must not change afterwards; the caller copies
        /// one that may.
        /// </param>
        /// <param name="time">When it was sent, on <see cref="SyncTicker"/>'s clock.</param>
        internal void Remember(JToken value, double time)
        {
            _newest = (_newest + 1) % Capacity;
            _values[_newest] = value;
            _times[_newest] = time;

            if (_count < Capacity)
                _count++;
        }

        /// <summary>
        /// Forgets everything: for when the member takes a value from elsewhere, after which what
        /// this object sent before says nothing about the server any more.
        /// </summary>
        internal void Clear()
        {
            Array.Clear(_values, 0, _values.Length);
            _count = 0;
            _newest = -1;
        }

        /// <summary>Whether a value was sent at or after <paramref name="since"/>.</summary>
        internal bool HasSentSince(double since) => _count > 0 && _times[_newest] >= since;

        /// <summary>
        /// Compares the server's value with the values sent at or after <paramref name="since"/>,
        /// newest first, as they read on the wire.
        /// </summary>
        internal Verdict Judge(JToken serverValue, double since)
        {
            if (!HasSentSince(since))
                return Verdict.NotSentRecently;

            var server = ToWireForm(serverValue);
            for (var age = 0; age < _count; age++)
            {
                var slot = (_newest - age + Capacity) % Capacity;

                // Sent in order, so everything past this one is older still.
                if (_times[slot] < since)
                    break;

                if (WireEquals(ToWireForm(_values[slot]), server))
                    return age == 0 ? Verdict.Arrived : Verdict.Lost;
            }

            return Verdict.ChangedElsewhere;
        }

        /// <summary>
        /// The value as a client reads it off the wire: written as the connection writes it, and
        /// read back as it reads every payload, with dates left as strings (see
        /// <c>WebServerConnection.ParsePayload</c>). A value sent from here is held as the float it
        /// was made from, 0.1f, which is not the double 0.1 that the server's answer reads as.
        /// </summary>
        private static JToken ToWireForm(JToken value)
        {
            if (value == null)
                return JValue.CreateNull();

            using (var reader = new JsonTextReader(new StringReader(value.ToString(Formatting.None))) { DateParseHandling = DateParseHandling.None })
                return JToken.ReadFrom(reader);
        }

        /// <summary>
        /// JSON equality, with one difference from <see cref="JToken.DeepEquals(JToken, JToken)"/>:
        /// an integer and a float of the same value are equal. A float member holding a whole number
        /// goes out as <c>2.0</c>, and the server, which is JavaScript, sends it back as <c>2</c>.
        /// </summary>
        internal static bool WireEquals(JToken a, JToken b)
        {
            if (IsNumber(a) && IsNumber(b))
                return a.Type == b.Type ? JToken.DeepEquals(a, b) : (double)a == (double)b;

            if (a is JArray arrayA && b is JArray arrayB)
            {
                if (arrayA.Count != arrayB.Count)
                    return false;

                for (var i = 0; i < arrayA.Count; i++)
                {
                    if (!WireEquals(arrayA[i], arrayB[i]))
                        return false;
                }
                return true;
            }

            if (a is JObject objectA && b is JObject objectB)
            {
                if (objectA.Count != objectB.Count)
                    return false;

                foreach (var property in objectA)
                {
                    if (!objectB.TryGetValue(property.Key, out var other) || !WireEquals(property.Value, other))
                        return false;
                }
                return true;
            }

            return JToken.DeepEquals(a, b);
        }

        private static bool IsNumber(JToken token) => token.Type == JTokenType.Integer || token.Type == JTokenType.Float;
    }
}
