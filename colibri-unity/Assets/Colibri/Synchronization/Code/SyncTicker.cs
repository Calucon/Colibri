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

            DestroyStrayTickers();
        }

        /// <summary>
        /// Cleans up tickers left behind by an earlier Play session.
        /// </summary>
        /// <remarks>
        /// The ticker GameObject used to carry <c>HideFlags.DontSave</c>, which does not only keep
        /// it out of the saved scene - it also exempts it from being destroyed when Play mode ends.
        /// One survived every Play session, still enabled, and since they all drive the same static
        /// list, the *n*-th session ran PollChanges and FlushUpdate n times per frame: duplicate
        /// messages on the wire and a sync cost that grew every time the play button was pressed.
        /// The flag is gone, but a project that has already accumulated them needs them clearing,
        /// and they outlive a domain reload.
        /// </remarks>
        private static void DestroyStrayTickers()
        {
            foreach (var stray in Resources.FindObjectsOfTypeAll<SyncTicker>())
            {
                if (stray)
                    Destroy(stray.gameObject);
            }
        }

        /// <summary>
        /// How many objects the ticker is currently driving, ignoring slots that have been cleared
        /// but not yet compacted. Exists for the end-to-end suite: "one ticker" and "one entry per
        /// synced object" are the two halves of the leak that made the *n*-th Play session send
        /// every update n times, and neither is observable from the public API.
        /// </summary>
        internal static int RegisteredCount
        {
            get
            {
                var count = 0;
                for (var i = 0; i < _tickables.Count; i++)
                {
                    if (_tickables[i] != null)
                        count++;
                }
                return count;
            }
        }

        internal static void Register(ITickable tickable)
        {
            if (tickable.TickIndex >= 0)
                return;

            // Nothing ticks outside Play mode, and registering there would leave an entry that
            // ResetState clears while the object still believes it is registered.
            if (!Application.isPlaying)
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

            // Deliberately not a SingletonBehaviour: that one creates its GameObject on any
            // property access, including from an editor window.
            //
            // No HideFlags: DontDestroyOnLoad already keeps this out of any saved scene, and
            // HideFlags.DontSave additionally survives Play mode - see DestroyStrayTickers.
            var go = new GameObject("[Colibri SyncTicker]");
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
