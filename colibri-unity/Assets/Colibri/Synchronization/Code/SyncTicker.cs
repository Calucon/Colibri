using System.Collections.Generic;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The single per-frame driver behind every <see cref="SyncBehaviour{T}"/> in the scene.
    ///
    /// Change detection used to be one reactive subscription per synced attribute, i.e. five
    /// per <c>SyncTransform</c>. This is one <c>Update</c> and one <c>LateUpdate</c> for the
    /// whole application, no matter how many objects are synchronized: <c>Update</c> polls every
    /// synced attribute for changes, <c>LateUpdate</c> flushes each object's accumulated changes
    /// as a single message. Splitting the two guarantees that a frame's changes are all collected
    /// before any of them go out.
    /// </summary>
    internal sealed class SyncTicker : MonoBehaviour
    {
        internal interface ITickable
        {
            /// <summary>
            /// Slot in the ticker's list, or -1 while unregistered. Owned by <see cref="SyncTicker"/>;
            /// implementations only have to store it and initialize it to -1.
            /// </summary>
            int TickIndex { get; set; }

            void PollChanges();
            void FlushUpdate();
        }

        private static readonly List<ITickable> _tickables = new List<ITickable>();
        private static bool _hasEmptySlots;
        private static SyncTicker _instance;

        // Statics survive Play mode when domain reload is disabled, which would otherwise leave
        // the list full of destroyed components from the previous session.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetState()
        {
            _tickables.Clear();
            _hasEmptySlots = false;
            _instance = null;
        }

        internal static void Register(ITickable tickable)
        {
            if (tickable.TickIndex >= 0)
                return;

            EnsureInstance();
            tickable.TickIndex = _tickables.Count;
            _tickables.Add(tickable);
        }

        internal static void Deregister(ITickable tickable)
        {
            var index = tickable.TickIndex;
            if (index < 0)
                return;

            // Cleared rather than removed: Deregister runs from OnDisable/OnDestroy, which can
            // happen in the middle of a tick, and RemoveAt would shift the indices under the loop.
            _tickables[index] = null;
            tickable.TickIndex = -1;
            _hasEmptySlots = true;
        }

        private static void EnsureInstance()
        {
            if (_instance)
                return;

            // Deliberately not a SingletonBehaviour: this must never spawn a GameObject from
            // edit mode, where synced objects register their attributes in Awake as well.
            if (!Application.isPlaying)
                return;

            var go = new GameObject("[Colibri SyncTicker]") { hideFlags = HideFlags.DontSave };
            _instance = go.AddComponent<SyncTicker>();
            DontDestroyOnLoad(go);
        }

        private void Update()
        {
            // Index loop over the raw list: no enumerator, no defensive copy, no allocation.
            for (var i = 0; i < _tickables.Count; i++)
                _tickables[i]?.PollChanges();
        }

        private void LateUpdate()
        {
            for (var i = 0; i < _tickables.Count; i++)
                _tickables[i]?.FlushUpdate();

            if (_hasEmptySlots)
                Compact();
        }

        private static void Compact()
        {
            _hasEmptySlots = false;

            var write = 0;
            for (var read = 0; read < _tickables.Count; read++)
            {
                var tickable = _tickables[read];
                if (tickable == null)
                    continue;

                _tickables[write] = tickable;
                tickable.TickIndex = write;
                write++;
            }

            _tickables.RemoveRange(write, _tickables.Count - write);
        }
    }
}
