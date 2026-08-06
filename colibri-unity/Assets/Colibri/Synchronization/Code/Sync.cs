using HCIKonstanz.Colibri.Networking;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static class Sync
    {
        private static WebServerConnection _connection;

        /// <summary>
        /// A registered callback, together with the Unity object it belongs to. Keeping the owner
        /// next to the delegate is what lets a listener disappear along with the component that
        /// registered it - see <see cref="ListenerOwner"/> for how the owner is found and why.
        /// </summary>
        private readonly struct Listener<T>
        {
            public readonly Action<T> Callback;

            private readonly UnityEngine.Object _owner;
            private readonly bool _isOwned;

            public Listener(Action<T> callback)
            {
                Callback = callback;
                _owner = ListenerOwner.Of(callback);
                // Resolved once, here: after the owner is destroyed, `_owner == null` can no
                // longer tell "belongs to a destroyed object" from "belongs to nothing at all".
                _isOwned = !ReferenceEquals(_owner, null);
            }

            /// <summary>True once the Unity object this listener belonged to has been destroyed.</summary>
            public bool IsOrphaned => _isOwned && _owner == null;
        }

        private static readonly Dictionary<string, List<Listener<bool>>> _boolListeners = new Dictionary<string, List<Listener<bool>>>();
        private static readonly Dictionary<string, List<Listener<int>>> _intListeners = new Dictionary<string, List<Listener<int>>>();
        private static readonly Dictionary<string, List<Listener<float>>> _floatListeners = new Dictionary<string, List<Listener<float>>>();
        private static readonly Dictionary<string, List<Listener<string>>> _stringListeners = new Dictionary<string, List<Listener<string>>>();
        private static readonly Dictionary<string, List<Listener<Vector2>>> _vector2Listeners = new Dictionary<string, List<Listener<Vector2>>>();
        private static readonly Dictionary<string, List<Listener<Vector3>>> _vector3Listeners = new Dictionary<string, List<Listener<Vector3>>>();
        private static readonly Dictionary<string, List<Listener<Quaternion>>> _quaternionListeners = new Dictionary<string, List<Listener<Quaternion>>>();
        private static readonly Dictionary<string, List<Listener<Color>>> _colorListeners = new Dictionary<string, List<Listener<Color>>>();
        private static readonly Dictionary<string, List<Listener<bool[]>>> _boolArrayListeners = new Dictionary<string, List<Listener<bool[]>>>();
        private static readonly Dictionary<string, List<Listener<int[]>>> _intArrayListeners = new Dictionary<string, List<Listener<int[]>>>();
        private static readonly Dictionary<string, List<Listener<float[]>>> _floatArrayListeners = new Dictionary<string, List<Listener<float[]>>>();
        private static readonly Dictionary<string, List<Listener<string[]>>> _stringArrayListeners = new Dictionary<string, List<Listener<string[]>>>();
        private static readonly Dictionary<string, List<Listener<Vector2[]>>> _vector2ArrayListeners = new Dictionary<string, List<Listener<Vector2[]>>>();
        private static readonly Dictionary<string, List<Listener<Vector3[]>>> _vector3ArrayListeners = new Dictionary<string, List<Listener<Vector3[]>>>();
        private static readonly Dictionary<string, List<Listener<Quaternion[]>>> _quaternionArrayListeners = new Dictionary<string, List<Listener<Quaternion[]>>>();
        private static readonly Dictionary<string, List<Listener<Color[]>>> _colorArrayListeners = new Dictionary<string, List<Listener<Color[]>>>();
        private static readonly Dictionary<string, List<Listener<JToken>>> _jsonListeners = new Dictionary<string, List<Listener<JToken>>>();

        private static readonly Dictionary<string, List<Listener<JObject>>> _modelUpdateListeners = new Dictionary<string, List<Listener<JObject>>>();
        private static readonly Dictionary<string, List<Listener<JObject>>> _modelDeleteListeners = new Dictionary<string, List<Listener<JObject>>>();

        /// <summary>
        /// The live connection, creating it on first use. Null only while the application is
        /// shutting down, when there is nothing left to send to.
        /// </summary>
        private static WebServerConnection Connection()
        {
            // Unity's ==, so the previous Play session's destroyed connection is replaced rather
            // than reused - see SingletonBehaviour.
            if (_connection == null)
            {
                _connection = WebServerConnection.Instance;
                if (_connection == null)
                    return null;

                _connection.OnMessageReceived += OnServerMessage;
            }
            return _connection;
        }

        private static void OnServerMessage(string channel, string command, JToken data)
        {
            RecordTraffic(true, channel, command);

            switch (command)
            {
                case "broadcast::bool":
                    Invoke(channel, _boolListeners, data.Value<bool>());
                    break;
                case "broadcast::int":
                    Invoke(channel, _intListeners, data.Value<int>());
                    break;
                case "broadcast::float":
                    Invoke(channel, _floatListeners, data.Value<float>());
                    break;
                case "broadcast::string":
                    Invoke(channel, _stringListeners, data.Value<string>());
                    break;
                case "broadcast::vector2":
                    Invoke(channel, _vector2Listeners, data.ToVector2());
                    break;
                case "broadcast::vector3":
                    Invoke(channel, _vector3Listeners, data.ToVector3());
                    break;
                case "broadcast::quaternion":
                    Invoke(channel, _quaternionListeners, data.ToQuaternion());
                    break;
                case "broadcast::color":
                    Invoke(channel, _colorListeners, data.ToColor());
                    break;

                case "broadcast::bool[]":
                    Invoke(channel, _boolArrayListeners, data.Select(x => (bool)x).ToArray());
                    break;
                case "broadcast::int[]":
                    Invoke(channel, _intArrayListeners, data.Select(x => (int)x).ToArray());
                    break;
                case "broadcast::float[]":
                    Invoke(channel, _floatArrayListeners, data.Select(x => (float)x).ToArray());
                    break;
                case "broadcast::string[]":
                    Invoke(channel, _stringArrayListeners, data.Select(x => (string)x).ToArray());
                    break;
                case "broadcast::vector2[]":
                    Invoke(channel, _vector2ArrayListeners, data.Select(x => x.ToVector2()).ToArray());
                    break;
                case "broadcast::vector3[]":
                    Invoke(channel, _vector3ArrayListeners, data.Select(x => x.ToVector3()).ToArray());
                    break;
                case "broadcast::quaternion[]":
                    Invoke(channel, _quaternionArrayListeners, data.Select(x => x.ToQuaternion()).ToArray());
                    break;
                case "broadcast::color[]":
                    Invoke(channel, _colorArrayListeners, data.Select(x => x.ToColor()).ToArray());
                    break;

                case "broadcast::json":
                    Invoke(channel, _jsonListeners, data);
                    break;

                case "model::update":
                    // Not routed through Invoke<T>: these are Colibri's own plumbing, so a model
                    // message arriving with nothing listening is not a type mismatch worth
                    // reporting - it is just a model this client does not have.
                    if (data is JObject updated)
                        Dispatch(channel, _modelUpdateListeners, updated, track: false);
                    break;

                case "model::delete":
                    if (data is JObject deleted)
                        Dispatch(channel, _modelDeleteListeners, deleted, track: false);
                    break;
            }
        }

        private static void Invoke<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, T val)
        {
            if (val == null)
                return;

            if (Dispatch(channel, listeners, val, track: true))
                return;

            // Nothing is listening for this type on this channel. That is only worth reporting
            // when *something else* is - a channel with no listeners at all is normal, since
            // every client sees every channel its app uses.
            if (ChannelListenerRegistry.TryDescribeMismatch(channel, typeof(T), out var message))
                Debug.LogWarning(message);
        }

        /// <summary>
        /// Calls everything still listening on the channel, dropping the listeners whose objects
        /// have been destroyed on the way past. Returns false when the channel had nobody left.
        /// </summary>
        private static bool Dispatch<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, T val, bool track)
        {
            if (!listeners.TryGetValue(channel, out var channelListeners))
                return false;

            Prune(channel, channelListeners, track);
            if (channelListeners.Count == 0)
            {
                // Left in place, an empty list would keep answering the lookup above, and every
                // future message on this channel would be dropped without a word.
                listeners.Remove(channel);
                return false;
            }

            // Copied, because a listener is allowed to register or unregister while being called.
            foreach (var listener in channelListeners.ToArray())
                listener.Callback.Invoke(val);

            return true;
        }

        /// <summary>Removes the listeners whose owning object is gone. See <see cref="ListenerOwner"/>.</summary>
        private static void Prune<T>(string channel, List<Listener<T>> channelListeners, bool track)
        {
            for (var i = channelListeners.Count - 1; i >= 0; i--)
            {
                if (!channelListeners[i].IsOrphaned)
                    continue;

                channelListeners.RemoveAt(i);
                if (track)
                    ChannelListenerRegistry.Remove(channel, typeof(T));
            }
        }


        /*
         *  Traffic log, for the Colibri Status window. Compiled out of release builds entirely,
         *  so neither the buffer nor the calls that fill it cost a shipped build anything.
         */

        public struct TrafficEntry
        {
            public bool Incoming;
            public string Channel;
            public string Command;
            public float Time;
        }

#if UNITY_EDITOR || DEVELOPMENT_BUILD
        private const int TrafficLogSize = 20;

        private const float DefaultTrafficRetentionSeconds = 10f;

        /// <summary>
        /// How long an entry stays in the log. It is a "what is happening right now" list, so an
        /// idle channel should empty out rather than leave the last twenty messages on screen
        /// with ages counting up indefinitely.
        /// </summary>
        /// <remarks>
        /// Settable only so the test suite can shorten it - a test that has to sit out the real
        /// ten seconds to watch an entry expire is one nobody will keep running.
        /// </remarks>
        internal static float TrafficRetentionSeconds = DefaultTrafficRetentionSeconds;

        private static readonly TrafficEntry[] _traffic = new TrafficEntry[TrafficLogSize];
        private static int _trafficCount;

        /// <summary>
        /// Entries survive Play mode with domain reload disabled, and their timestamps are
        /// <c>realtimeSinceStartup</c> - which keeps running in edit mode. Without this the next
        /// session opened showing the last one's messages, dated from before it started.
        /// </summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetTraffic()
        {
            Array.Clear(_traffic, 0, _traffic.Length);
            _trafficCount = 0;
            TrafficRetentionSeconds = DefaultTrafficRetentionSeconds;
        }

        /// <summary>
        /// The most recent messages sent and received, newest first, dropping anything older
        /// than <see cref="TrafficRetentionSeconds"/>.
        /// </summary>
        public static IEnumerable<TrafficEntry> RecentTraffic
        {
            get
            {
                var oldest = Time.realtimeSinceStartup - TrafficRetentionSeconds;
                var count = Math.Min(_trafficCount, TrafficLogSize);

                for (var i = 1; i <= count; i++)
                {
                    var entry = _traffic[(_trafficCount - i) % TrafficLogSize];

                    // Newest first, so the first entry past the window means every entry after it
                    // is older still.
                    if (entry.Time < oldest)
                        yield break;

                    yield return entry;
                }
            }
        }
#else
        public static IEnumerable<TrafficEntry> RecentTraffic => Enumerable.Empty<TrafficEntry>();
#endif

        [System.Diagnostics.Conditional("UNITY_EDITOR"), System.Diagnostics.Conditional("DEVELOPMENT_BUILD")]
        private static void RecordTraffic(bool incoming, string channel, string command)
        {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            _traffic[_trafficCount % TrafficLogSize] = new TrafficEntry
            {
                Incoming = incoming,
                Channel = channel,
                Command = command,
                Time = Time.realtimeSinceStartup
            };
            _trafficCount++;
#endif
        }

        private static void SendCommand(string channel, string command, JToken data)
        {
            var connection = Connection();
            if (connection == null)
                return;

            RecordTraffic(false, channel, command);
            connection.SendCommand(channel, command, data);
        }


        /*
         *  Sending data
         */
        public static void Send(string channel, bool data) => SendCommand(channel, "broadcast::bool", data.ToJson());
        public static void Send(string channel, int data) => SendCommand(channel, "broadcast::int", data.ToJson());
        public static void Send(string channel, float data) => SendCommand(channel, "broadcast::float", data.ToJson());
        public static void Send(string channel, string data) => SendCommand(channel, "broadcast::string", data.ToJson());
        public static void Send(string channel, Vector2 data) => SendCommand(channel, "broadcast::vector2", data.ToJson());
        public static void Send(string channel, Vector3 data) => SendCommand(channel, "broadcast::vector3", data.ToJson());
        public static void Send(string channel, Quaternion data) => SendCommand(channel, "broadcast::quaternion", data.ToJson());
        public static void Send(string channel, Color data) => SendCommand(channel, "broadcast::color", data.ToJson());
        public static void Send(string channel, bool[] data) => SendCommand(channel, "broadcast::bool[]", new JArray(data));
        public static void Send(string channel, int[] data) => SendCommand(channel, "broadcast::int[]", new JArray(data));
        public static void Send(string channel, float[] data) => SendCommand(channel, "broadcast::float[]", new JArray(data));
        public static void Send(string channel, string[] data) => SendCommand(channel, "broadcast::string[]", new JArray(data));
        public static void Send(string channel, Vector2[] data) => SendCommand(channel, "broadcast::vector2[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, Vector3[] data) => SendCommand(channel, "broadcast::vector3[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, Quaternion[] data) => SendCommand(channel, "broadcast::quaternion[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, Color[] data) => SendCommand(channel, "broadcast::color[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, JToken data) => SendCommand(channel, "broadcast::json", data);

        public static void SendModelUpdate(string channel, JObject data) => SendCommand(channel, "model::update", data);
        public static void SendModelDelete(string channel, string id) => SendCommand(channel, "model::delete", new JObject { { "id", id } });




        /*
         *  Listeners
         */

        // `track` is off for the model channels: they are Colibri's own SyncBehaviour plumbing,
        // they never go through Invoke<T>, and listing them would only bury the channels the
        // student actually wrote.
        private static void AddListener<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, Action<T> listener, bool track = true)
        {
            if (!listeners.TryGetValue(channel, out var channelListeners))
            {
                channelListeners = new List<Listener<T>>();
                listeners.Add(channel, channelListeners);
                // ensure that networkconnection prefab is added to the scene
                Connection();
            }
            else
            {
                // Registering is the other natural moment to sweep: reloading a scene registers
                // everything again, and without this the previous scene's listeners would pile up
                // on a channel that nothing happens to send on.
                Prune(channel, channelListeners, track);
            }

            channelListeners.Add(new Listener<T>(listener));

            if (track)
                ChannelListenerRegistry.Add(channel, typeof(T));
        }

        private static void RemoveListener<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, Action<T> listener, bool track = true)
        {
            if (!listeners.TryGetValue(channel, out var channelListeners))
                return;

            for (var i = 0; i < channelListeners.Count; i++)
            {
                if (!channelListeners[i].Callback.Equals(listener))
                    continue;

                channelListeners.RemoveAt(i);
                if (track)
                    ChannelListenerRegistry.Remove(channel, typeof(T));
                break;
            }

            Prune(channel, channelListeners, track);

            if (channelListeners.Count == 0)
                listeners.Remove(channel);
        }

        public static void Receive(string channel, Action<bool> listener) => AddListener(channel, _boolListeners, listener);
        public static void Unregister(string channel, Action<bool> listener) => RemoveListener(channel, _boolListeners, listener);

        public static void Receive(string channel, Action<int> listener) => AddListener(channel, _intListeners, listener);
        public static void Unregister(string channel, Action<int> listener) => RemoveListener(channel, _intListeners, listener);

        public static void Receive(string channel, Action<float> listener) => AddListener(channel, _floatListeners, listener);
        public static void Unregister(string channel, Action<float> listener) => RemoveListener(channel, _floatListeners, listener);

        public static void Receive(string channel, Action<string> listener) => AddListener(channel, _stringListeners, listener);
        public static void Unregister(string channel, Action<string> listener) => RemoveListener(channel, _stringListeners, listener);

        public static void Receive(string channel, Action<Vector2> listener) => AddListener(channel, _vector2Listeners, listener);
        public static void Unregister(string channel, Action<Vector2> listener) => RemoveListener(channel, _vector2Listeners, listener);

        public static void Receive(string channel, Action<Vector3> listener) => AddListener(channel, _vector3Listeners, listener);
        public static void Unregister(string channel, Action<Vector3> listener) => RemoveListener(channel, _vector3Listeners, listener);

        public static void Receive(string channel, Action<Quaternion> listener) => AddListener(channel, _quaternionListeners, listener);
        public static void Unregister(string channel, Action<Quaternion> listener) => RemoveListener(channel, _quaternionListeners, listener);

        public static void Receive(string channel, Action<Color> listener) => AddListener(channel, _colorListeners, listener);
        public static void Unregister(string channel, Action<Color> listener) => RemoveListener(channel, _colorListeners, listener);

        public static void Receive(string channel, Action<bool[]> listener) => AddListener(channel, _boolArrayListeners, listener);
        public static void Unregister(string channel, Action<bool[]> listener) => RemoveListener(channel, _boolArrayListeners, listener);

        public static void Receive(string channel, Action<int[]> listener) => AddListener(channel, _intArrayListeners, listener);
        public static void Unregister(string channel, Action<int[]> listener) => RemoveListener(channel, _intArrayListeners, listener);

        public static void Receive(string channel, Action<float[]> listener) => AddListener(channel, _floatArrayListeners, listener);
        public static void Unregister(string channel, Action<float[]> listener) => RemoveListener(channel, _floatArrayListeners, listener);

        public static void Receive(string channel, Action<string[]> listener) => AddListener(channel, _stringArrayListeners, listener);
        public static void Unregister(string channel, Action<string[]> listener) => RemoveListener(channel, _stringArrayListeners, listener);

        public static void Receive(string channel, Action<Vector2[]> listener) => AddListener(channel, _vector2ArrayListeners, listener);
        public static void Unregister(string channel, Action<Vector2[]> listener) => RemoveListener(channel, _vector2ArrayListeners, listener);

        public static void Receive(string channel, Action<Vector3[]> listener) => AddListener(channel, _vector3ArrayListeners, listener);
        public static void Unregister(string channel, Action<Vector3[]> listener) => RemoveListener(channel, _vector3ArrayListeners, listener);

        public static void Receive(string channel, Action<Quaternion[]> listener) => AddListener(channel, _quaternionArrayListeners, listener);
        public static void Unregister(string channel, Action<Quaternion[]> listener) => RemoveListener(channel, _quaternionArrayListeners, listener);

        public static void Receive(string channel, Action<Color[]> listener) => AddListener(channel, _colorArrayListeners, listener);
        public static void Unregister(string channel, Action<Color[]> listener) => RemoveListener(channel, _colorArrayListeners, listener);


        public static void Receive(string channel, Action<JToken> listener) => AddListener(channel, _jsonListeners, listener);
        public static void Unregister(string channel, Action<JToken> listener) => RemoveListener(channel, _jsonListeners, listener);

        public static void AddModelUpdateListener(string channel, Action<JObject> listener)
        {
            AddListener(channel, _modelUpdateListeners, listener, track: false);
            SendCommand(channel, "model::request", null);
        }

        public static void AddModelUpdateListener(string channel, Action<JObject> listener, string fetchInitialStateId)
        {
            AddListener(channel, _modelUpdateListeners, listener, track: false);
            SendCommand(channel, "model::request", new JObject { { "id", fetchInitialStateId } });
        }

        public static void RemoveModelUpdateListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelUpdateListeners, listener, track: false);

        public static void AddModelDeleteListener(string channel, Action<JObject> listener) => AddListener(channel, _modelDeleteListeners, listener, track: false);
        public static void RemoveModelDeleteListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelDeleteListeners, listener, track: false);




        /*
         *  Generic listener registration.
         *
         *  Receive is overloaded once per supported type, which makes
         *      Sync.Receive("MyChannel", MyHandler)
         *  ambiguous and forces a cast onto every call site. Naming the type instead -
         *      Sync.Receive<float>("MyChannel", MyHandler)
         *  - is unambiguous, because supplying type arguments rules the overloads out.
         *
         *  Dispatch is a pattern match on the delegate, so there is no reflection involved and
         *  the compiler still sees the same typed calls as before.
         *
         *  There is deliberately no Send<T>: Sync.Send("ch", value) already resolves without a
         *  cast, so a generic version would buy nothing and would turn today's compile error on
         *  an unsupported type into a runtime message.
         */

        private const string SupportedTypes = "bool, int, float, string, Vector2, Vector3, Quaternion, Color, JToken and arrays of those";

        public static void Receive<T>(string channel, Action<T> listener)
        {
            switch (listener)
            {
                case Action<bool> l: Receive(channel, l); break;
                case Action<int> l: Receive(channel, l); break;
                case Action<float> l: Receive(channel, l); break;
                case Action<string> l: Receive(channel, l); break;
                case Action<Vector2> l: Receive(channel, l); break;
                case Action<Vector3> l: Receive(channel, l); break;
                case Action<Quaternion> l: Receive(channel, l); break;
                case Action<Color> l: Receive(channel, l); break;
                case Action<bool[]> l: Receive(channel, l); break;
                case Action<int[]> l: Receive(channel, l); break;
                case Action<float[]> l: Receive(channel, l); break;
                case Action<string[]> l: Receive(channel, l); break;
                case Action<Vector2[]> l: Receive(channel, l); break;
                case Action<Vector3[]> l: Receive(channel, l); break;
                case Action<Quaternion[]> l: Receive(channel, l); break;
                case Action<Color[]> l: Receive(channel, l); break;
                case Action<JToken> l: Receive(channel, l); break;
                default: LogUnsupportedType<T>(channel); break;
            }
        }

        public static void Unregister<T>(string channel, Action<T> listener)
        {
            switch (listener)
            {
                case Action<bool> l: Unregister(channel, l); break;
                case Action<int> l: Unregister(channel, l); break;
                case Action<float> l: Unregister(channel, l); break;
                case Action<string> l: Unregister(channel, l); break;
                case Action<Vector2> l: Unregister(channel, l); break;
                case Action<Vector3> l: Unregister(channel, l); break;
                case Action<Quaternion> l: Unregister(channel, l); break;
                case Action<Color> l: Unregister(channel, l); break;
                case Action<bool[]> l: Unregister(channel, l); break;
                case Action<int[]> l: Unregister(channel, l); break;
                case Action<float[]> l: Unregister(channel, l); break;
                case Action<string[]> l: Unregister(channel, l); break;
                case Action<Vector2[]> l: Unregister(channel, l); break;
                case Action<Vector3[]> l: Unregister(channel, l); break;
                case Action<Quaternion[]> l: Unregister(channel, l); break;
                case Action<Color[]> l: Unregister(channel, l); break;
                case Action<JToken> l: Unregister(channel, l); break;
                default: LogUnsupportedType<T>(channel); break;
            }
        }

        private static void LogUnsupportedType<T>(string channel)
        {
            var name = ChannelListenerRegistry.FriendlyName(typeof(T));
            Debug.LogError($"Colibri: cannot receive '{name}' on channel '{channel}' - supported types are {SupportedTypes}. "
                + $"For your own classes, receive a JToken and convert it: Sync.Receive<JToken>(\"{channel}\", token => token.ToObject<{name}>()).");
        }
    }
}
