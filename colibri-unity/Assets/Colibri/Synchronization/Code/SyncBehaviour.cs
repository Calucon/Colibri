using UnityEngine;
using System.Reflection;
using System.Collections.Generic;
using System;
#if !ENABLE_IL2CPP
using System.Linq.Expressions;
#endif
using Newtonsoft.Json.Linq;
using System.Linq;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviour<T> : MonoBehaviour, SyncTicker.ITickable
        where T : SyncBehaviour<T>
    {
        private const string SupportedTypes = "bool, int, float, string, Vector2, Vector3, Quaternion, Color, JObject and arrays of those";

        /*
         *  Synced attribute metadata. Built once per model type, never per instance, and typed
         *  all the way down: the change comparison never sees `object`, so an idle synced object
         *  allocates nothing at all.
         */

        private interface IChangeTracker
        {
            /// <summary>
            /// Latches the attribute's current value and reports whether it differs from the
            /// previously latched one.
            /// </summary>
            bool CaptureChange(T target);
        }

        private abstract class SyncedAttribute
        {
            public string Name;
            public int Index;
            public Type PropertyType;

            /// <summary>Boxes, so it is only called once a change has actually been detected.</summary>
            public abstract object GetBoxed(T target);
            public abstract void SetBoxed(T target, object value);
            public abstract IChangeTracker CreateTracker(T target);
        }

        private sealed class SyncedAttribute<TValue> : SyncedAttribute
        {
            public Func<T, TValue> Getter;
            public Action<T, TValue> Setter;

            public override object GetBoxed(T target) => Getter(target);
            public override void SetBoxed(T target, object value) => Setter(target, (TValue)value);
            public override IChangeTracker CreateTracker(T target) => new ChangeTracker<TValue>(Getter, target);
        }

        private sealed class ChangeTracker<TValue> : IChangeTracker
        {
            private readonly Func<T, TValue> _getter;
            private TValue _lastValue;

            public ChangeTracker(Func<T, TValue> getter, T target)
            {
                _getter = getter;
                _lastValue = getter(target);
            }

            public bool CaptureChange(T target)
            {
                var current = _getter(target);

                // EqualityComparer<TValue>.Default resolves to the IEquatable<> implementation
                // for Vector3/Quaternion/..., so comparing costs nothing and boxes nothing.
                if (EqualityComparer<TValue>.Default.Equals(current, _lastValue))
                    return false;

                _lastValue = current;
                return true;
            }
        }


        public static event Action<SyncBehaviour<T>> ModelCreated;
        public static event Action<SyncBehaviour<T>> ModelDestroyed;


        private static readonly Dictionary<string, SyncedAttribute> _syncedAttributes = new Dictionary<string, SyncedAttribute>();
        private static readonly List<SyncedAttribute> _attributeList = new List<SyncedAttribute>();
        private static bool _isInitialized = false;

        private static void Initialize()
        {
            if (_isInitialized)
                return;

            _isInitialized = true;

            const BindingFlags memberFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

            foreach (var prop in typeof(T).GetProperties(memberFlags))
                if (prop.IsDefined(typeof(SyncAttribute), true))
                    RegisterAttribute(prop.Name, prop.PropertyType, prop);

            foreach (var field in typeof(T).GetFields(memberFlags))
                if (field.IsDefined(typeof(SyncAttribute), true))
                    RegisterAttribute(field.Name, field.FieldType, field);
        }

        /// <summary>
        /// How a C# name - a model type or a [Sync] member - becomes its name on the wire.
        /// </summary>
        /// <remarks>
        /// Invariant on purpose. Culture-sensitive <c>ToLower()</c> turns 'I' into a dotless i
        /// (U+0131) on Turkish and Azerbaijani systems, so on such a machine "PhysicsId" went out
        /// with a character in it that neither colibri-web's <c>toLowerCase()</c> nor any other
        /// client produces, and the member silently stopped syncing.
        /// </remarks>
        internal static string ToWireName(string name) => name.ToLowerInvariant();

        /// <summary>The wire names of this model type's [Sync] members. Exists for the test suite.</summary>
        internal static IEnumerable<string> SyncedNames
        {
            get
            {
                Initialize();
                return _syncedAttributes.Keys;
            }
        }

        private static void RegisterAttribute(string memberName, Type valueType, MemberInfo member)
        {
            var name = ToWireName(memberName);
            if (_syncedAttributes.ContainsKey(name))
            {
                Debug.LogError($"Colibri: '{typeof(T).Name}' has more than one [Sync] member named '{memberName}' (names are matched case-insensitively). Rename one of them.");
                return;
            }

            var attribute = BuildAttribute(name, valueType, member);
            if (attribute == null)
                return;

            attribute.Index = _attributeList.Count;
            _attributeList.Add(attribute);
            _syncedAttributes.Add(name, attribute);
        }

        // Explicit per-type dispatch rather than MakeGenericMethod: every BuildAttribute<TValue>,
        // and with it SyncedAttribute<TValue>, ChangeTracker<TValue> and the Func/Action delegate
        // types, is a closed instantiation IL2CPP can see and compile ahead of time. It is also the
        // one place that can tell a student up front that their [Sync] member has a type Colibri
        // cannot put on the wire.
        private static SyncedAttribute BuildAttribute(string name, Type valueType, MemberInfo member)
        {
            if (valueType == typeof(bool)) return BuildAttribute<bool>(name, member);
            if (valueType == typeof(int)) return BuildAttribute<int>(name, member);
            if (valueType == typeof(float)) return BuildAttribute<float>(name, member);
            if (valueType == typeof(string)) return BuildAttribute<string>(name, member);
            if (valueType == typeof(Vector2)) return BuildAttribute<Vector2>(name, member);
            if (valueType == typeof(Vector3)) return BuildAttribute<Vector3>(name, member);
            if (valueType == typeof(Quaternion)) return BuildAttribute<Quaternion>(name, member);
            if (valueType == typeof(Color)) return BuildAttribute<Color>(name, member);
            if (valueType == typeof(bool[])) return BuildAttribute<bool[]>(name, member);
            if (valueType == typeof(int[])) return BuildAttribute<int[]>(name, member);
            if (valueType == typeof(float[])) return BuildAttribute<float[]>(name, member);
            if (valueType == typeof(string[])) return BuildAttribute<string[]>(name, member);
            if (valueType == typeof(Vector2[])) return BuildAttribute<Vector2[]>(name, member);
            if (valueType == typeof(Vector3[])) return BuildAttribute<Vector3[]>(name, member);
            if (valueType == typeof(Quaternion[])) return BuildAttribute<Quaternion[]>(name, member);
            if (valueType == typeof(Color[])) return BuildAttribute<Color[]>(name, member);
            if (valueType == typeof(JObject)) return BuildAttribute<JObject>(name, member);

            Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - [Sync] does not support {valueType.Name}. Supported types are {SupportedTypes}. For your own classes, sync a JObject built with JToken.FromObject(...).");
            return null;
        }

        private static SyncedAttribute BuildAttribute<TValue>(string name, MemberInfo member)
        {
            if (member is PropertyInfo property)
            {
                if (property.GetGetMethod(true) == null || property.GetSetMethod(true) == null)
                {
                    Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - a [Sync] property needs both a getter and a setter.");
                    return null;
                }
            }
            else if (((FieldInfo)member).IsInitOnly)
            {
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - a [Sync] field cannot be readonly.");
                return null;
            }

            Func<T, TValue> getter;
            Action<T, TValue> setter;
            try
            {
#if ENABLE_IL2CPP
                CreateReflectionAccessors<TValue>(member, out getter, out setter);
#else
                CreateCompiledAccessors<TValue>(member, out getter, out setter);
#endif
            }
            catch (Exception e)
            {
                // Once per member and type, at startup - but an exception here would escape from
                // the first Awake and leave that object half set up, so it is reported instead.
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - {e.GetType().Name}: {e.Message}");
                return null;
            }

            return new SyncedAttribute<TValue>
            {
                Name = name,
                PropertyType = typeof(TValue),
                Getter = getter,
                Setter = setter
            };
        }

        /// <summary>
        /// Accessors for IL2CPP, which has no JIT: no expression trees, nothing compiled at runtime.
        /// </summary>
        /// <remarks>
        /// <para>
        /// Under IL2CPP, <c>LambdaExpression.Compile()</c> does not fail - it quietly falls back to
        /// the System.Linq.Expressions interpreter, which builds its delegate through
        /// <c>MakeGenericMethod</c> at runtime. That is slow on every call, and for value types it
        /// depends on generic code IL2CPP may not have generated. So under ENABLE_IL2CPP:
        /// </para>
        /// <para>
        /// A property gets open-instance delegates bound straight to its get and set methods - the
        /// same typed call a compiled lambda makes, so the per-frame poll stays free of allocation.
        /// </para>
        /// <para>
        /// A field goes through <c>FieldInfo.GetValue</c>/<c>SetValue</c>, as it did in 1.x. That
        /// boxes a value-type field on every poll; there is no allocation-free way to read a field
        /// through reflection without a JIT. A hot value-type member is cheaper as a property.
        /// </para>
        /// <para>
        /// Compiled on every backend so the test suite can run it in the Editor, which is always
        /// Mono. The member must already have been validated by <see cref="BuildAttribute{TValue}"/>.
        /// </para>
        /// </remarks>
        internal static void CreateReflectionAccessors<TValue>(MemberInfo member, out Func<T, TValue> getter, out Action<T, TValue> setter)
        {
            if (member is PropertyInfo property)
            {
                getter = (Func<T, TValue>)Delegate.CreateDelegate(typeof(Func<T, TValue>), property.GetGetMethod(true));
                setter = (Action<T, TValue>)Delegate.CreateDelegate(typeof(Action<T, TValue>), property.GetSetMethod(true));
                return;
            }

            var field = (FieldInfo)member;
            getter = target => (TValue)field.GetValue(target);
            setter = (target, value) => field.SetValue(target, value);
        }

#if !ENABLE_IL2CPP
        /// <summary>
        /// Accessors for Mono, compiled from expression trees: typed for properties and fields
        /// alike, so nothing boxes.
        /// </summary>
        private static void CreateCompiledAccessors<TValue>(MemberInfo member, out Func<T, TValue> getter, out Action<T, TValue> setter)
        {
            var exTarget = Expression.Parameter(typeof(T), "target");
            var exValue = Expression.Parameter(typeof(TValue), "value");

            Expression exGet;
            Expression exSet;

            if (member is PropertyInfo property)
            {
                // see: https://stackoverflow.com/a/17669142/4090817
                exGet = Expression.Call(exTarget, property.GetGetMethod(true));
                exSet = Expression.Call(exTarget, property.GetSetMethod(true), exValue);
            }
            else
            {
                var field = (FieldInfo)member;
                exGet = Expression.Field(exTarget, field);
                exSet = Expression.Assign(Expression.Field(exTarget, field), exValue);
            }

            getter = Expression.Lambda<Func<T, TValue>>(exGet, exTarget).Compile();
            setter = Expression.Lambda<Action<T, TValue>>(exSet, exTarget, exValue).Compile();
        }
#endif


        public string Id;

        public string ModelId = "";
        private readonly string ChannelPrefix = ToWireName(typeof(T).Name);
        internal string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(ModelId) ? "" : $"_{ModelId}"); }

        // Parallel to _attributeList: true while an incoming server value is still waiting to be
        // observed by the change poll, so that it is not immediately echoed back to the server.
        private bool[] _hasReceivedUpdate;
        private IChangeTracker[] _trackers;

        private JObject _nextUpdate;

        private bool _isQuitting;
        private bool _hasReceivedDestroyCommand;
        private bool _hasReceivedFirstUpdate;

        private readonly TaskCompletionSource<bool> _isReady = new TaskCompletionSource<bool>();

        private int _tickIndex = -1;
        int SyncTicker.ITickable.TickIndex { get => _tickIndex; set => _tickIndex = value; }


        protected virtual void Awake()
        {
            Initialize();

            // Awake only ever runs on an object in a scene - a placed or an instantiated one,
            // never a prefab asset - so there is no prefab case to exclude here.
            if (String.IsNullOrEmpty(Id))
                Id = Guid.NewGuid().ToString();

            var self = this as T;
            _hasReceivedUpdate = new bool[_attributeList.Count];
            _trackers = new IChangeTracker[_attributeList.Count];
            for (var i = 0; i < _attributeList.Count; i++)
                _trackers[i] = _attributeList[i].CreateTracker(self);

            SyncTicker.Register(this);

            Sync.AddModelUpdateListener(Channel, OnModelUpdate, Id);
            Sync.AddModelDeleteListener(Channel, OnModelDelete);

            ModelCreated?.Invoke(this);

            // check if the scene contains a matching manager
            var hasManager = FindObjectsByType<SyncBehaviourManager<T>>(FindObjectsSortMode.None)
                .Where(m => m.Template?.ModelId == ModelId || (String.IsNullOrEmpty(m.Template?.ModelId) && String.IsNullOrEmpty(ModelId)))
                .Any();

            if (!hasManager)
            {
                if (String.IsNullOrEmpty(ModelId))
                    Debug.LogWarning("No generic Colibri SyncManager found (without ModelId) - synchronization of newly created objects may be restricted");
                else
                    Debug.LogWarning($"No Colibri SyncManager found (ModelID '{ModelId}') - synchronization of newly created objects may be restricted");
            }
        }

        protected virtual void OnApplicationQuit()
        {
            _isQuitting = true;
        }

        protected virtual void OnDestroy()
        {
            SyncTicker.Deregister(this);

            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);
            Sync.RemoveModelDeleteListener(Channel, OnModelDelete);

            ModelDestroyed?.Invoke(this);
            if (_isQuitting || _hasReceivedDestroyCommand)
                return;

            Sync.SendModelDelete(Channel, Id);
            _isReady.TrySetCanceled();
        }


        /*
         *  Driven by SyncTicker - one Update and one LateUpdate for the whole application.
         */

        void SyncTicker.ITickable.PollChanges()
        {
            // A disabled object neither latches nor sends, so whatever changed while it was
            // disabled is picked up as a normal change the frame it comes back.
            if (!isActiveAndEnabled)
                return;

            var self = this as T;
            for (var i = 0; i < _trackers.Length; i++)
            {
                // Latched unconditionally, but only reported once the server has sent this
                // object's state - otherwise the local value would overwrite it on arrival.
                if (!_trackers[i].CaptureChange(self))
                    continue;

                if (_hasReceivedFirstUpdate)
                    AddUpdate(_attributeList[i], _attributeList[i].GetBoxed(self));
            }
        }

        void SyncTicker.ITickable.FlushUpdate()
        {
            if (_nextUpdate == null)
                return;

            Sync.SendModelUpdate(Channel, _nextUpdate);
            _nextUpdate = null;
        }


        public void OnModelUpdate(JObject data)
        {
            var id = data["id"].Value<string>();
            if (id == Id)
            {
                _hasReceivedFirstUpdate = true;

                foreach (var prop in data)
                {
                    if (prop.Key != "id")
                        UpdateAttribute(prop.Key, prop.Value);
                }

                _isReady.TrySetResult(true);
            }
        }

        public async void TriggerSync()
        {
            try
            {
                await _isReady.Task;
            }
            catch (OperationCanceledException)
            {
                // destroyed before the server ever sent its state - nothing left to sync
                return;
            }

            if (!this)
                return;

            var self = this as T;
            foreach (var attribute in _attributeList)
                AddUpdate(attribute, attribute.GetBoxed(self));
        }


        private void OnModelDelete(JObject data)
        {
            var id = data["id"].Value<string>();
            if (id == Id)
            {
                _hasReceivedDestroyCommand = true;
                Destroy(gameObject, 0.001f);
            }
        }

        private void AddUpdate(SyncedAttribute attribute, object value)
        {
            if (_hasReceivedUpdate[attribute.Index])
            {
                _hasReceivedUpdate[attribute.Index] = false;
                return;
            }

            if (_nextUpdate == null)
                _nextUpdate = new JObject { { "id", Id } };

            if (_nextUpdate.ContainsKey(attribute.Name))
                _nextUpdate[attribute.Name] = value.ToJson();
            else
                _nextUpdate.Add(attribute.Name, value.ToJson());

            // The message itself goes out in FlushUpdate(), so all of this frame's changes
            // travel together in one message.
        }

        private void UpdateAttribute(string name, JToken value)
        {
            if (!_syncedAttributes.ContainsKey(name))
            {
                Debug.LogWarning($"Unable to sync attribute {name}");
                return;
            }

            var self = this as T;
            var attribute = _syncedAttributes[name];
            var oldValue = attribute.GetBoxed(self);

            if (attribute.PropertyType == typeof(bool))
                attribute.SetBoxed(self, value.Value<bool>());
            else if (attribute.PropertyType == typeof(int))
                attribute.SetBoxed(self, value.Value<int>());
            else if (attribute.PropertyType == typeof(float))
                attribute.SetBoxed(self, value.Value<float>());
            else if (attribute.PropertyType == typeof(string))
                attribute.SetBoxed(self, value.Value<string>());
            else if (attribute.PropertyType == typeof(Vector2))
                attribute.SetBoxed(self, value.ToVector2());
            else if (attribute.PropertyType == typeof(Vector3))
                attribute.SetBoxed(self, value.ToVector3());
            else if (attribute.PropertyType == typeof(Quaternion))
                attribute.SetBoxed(self, value.ToQuaternion());
            else if (attribute.PropertyType == typeof(Color))
                attribute.SetBoxed(self, value.ToColor());
            else if (attribute.PropertyType == typeof(bool[]))
                attribute.SetBoxed(self, value.Select(x => (bool)x).ToArray());
            else if (attribute.PropertyType == typeof(int[]))
                attribute.SetBoxed(self, value.Select(x => (int)x).ToArray());
            else if (attribute.PropertyType == typeof(float[]))
                attribute.SetBoxed(self, value.Select(x => (float)x).ToArray());
            else if (attribute.PropertyType == typeof(string[]))
                attribute.SetBoxed(self, value.Select(x => (string)x).ToArray());
            else if (attribute.PropertyType == typeof(Vector2[]))
                attribute.SetBoxed(self, value.Select(x => x.ToVector2()).ToArray());
            else if (attribute.PropertyType == typeof(Vector3[]))
                attribute.SetBoxed(self, value.Select(x => x.ToVector3()).ToArray());
            else if (attribute.PropertyType == typeof(Quaternion[]))
                attribute.SetBoxed(self, value.Select(x => x.ToQuaternion()).ToArray());
            else if (attribute.PropertyType == typeof(Color[]))
                attribute.SetBoxed(self, value.Select(x => x.ToColor()).ToArray());
            else if (attribute.PropertyType == typeof(JObject))
                attribute.SetBoxed(self, value);
            else
                Debug.LogError($"Unable to update attribute {name}: Unsupported type {attribute.PropertyType}");

            var newValue = attribute.GetBoxed(self);
            if (newValue != null)
                _hasReceivedUpdate[attribute.Index] = !newValue.Equals(oldValue);
            else
                _hasReceivedUpdate[attribute.Index] = newValue != oldValue;
        }
    }
}
