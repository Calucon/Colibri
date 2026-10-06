using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviourManager<T> : MonoBehaviour
        where T : SyncBehaviour<T>
    {
        private readonly string ChannelPrefix = SyncBehaviour<T>.ToWireName(typeof(T).Name);
        internal string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(Template?.ModelId) ? "" : $"_{Template.ModelId}"); }

        public T Template;

        private readonly List<T> _existingObjects = new List<T>();
        private bool _isCreatingObject;

        private void Start()
        {
            var existingBehaviours = FindObjectsByType<T>(FindObjectsSortMode.None)
                .Where(o => o.ModelId == Template?.ModelId || (Template == null && String.IsNullOrEmpty(o.ModelId)));
            _existingObjects.AddRange(existingBehaviours);

            foreach (var existingBehaviour in existingBehaviours)
                existingBehaviour.TriggerSync();

            Sync.AddModelUpdateListener(Channel, OnModelUpdate);

            // Listen for newly instantiated objects and propagate initial state
            SyncBehaviour<T>.ModelCreated += OnModelCreated;
            SyncBehaviour<T>.ModelDestroyed += OnModelDestroyed;

            // Help developers debug potential Colibri issues
            if (!Template)
                Debug.LogWarning($"No template provided for Colibri manager '{GetType().FullName}' { (String.IsNullOrEmpty(Template?.ModelId) ? "" : $"(ModelID: {Template?.ModelId})") }, unable to instantiate new objects!");

            // Avoid potential ModelId overlaps
            var hasConflict = FindObjectsByType(GetType(), FindObjectsSortMode.None)
                .Where(o => o != this)
                .Any(o => (o as SyncBehaviourManager<T>)?.Template?.ModelId == Template?.ModelId);
            if (hasConflict)
                Debug.LogWarning($"Warning: Multiple instances of '{GetType().FullName}' detected with overlapping ModelID. Please only use one manager for each synced model or specify unique ModelID!");
        }
        private void OnDestroy()
        {
            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);

            // Static events do not unsubscribe themselves. Missing this leaks a handler - and its
            // destroyed manager - into the next Play session whenever domain reload is disabled.
            SyncBehaviour<T>.ModelCreated -= OnModelCreated;
            SyncBehaviour<T>.ModelDestroyed -= OnModelDestroyed;
        }

        private void OnModelCreated(SyncBehaviour<T> model)
        {
            if (!(model is T))
                return;
            if (model.ModelId != Template?.ModelId && !(Template == null && String.IsNullOrEmpty(model.ModelId)))
                return;
            if (_isCreatingObject)
                return;
            if (_existingObjects.Any(e => e.Id == model.Id))
                return;

            _existingObjects.Add(model as T);
            model.TriggerSync();
        }

        private void OnModelDestroyed(SyncBehaviour<T> model)
        {
            if (model is T typed)
                _existingObjects.Remove(typed);
        }

        private void OnModelUpdate(JObject data)
        {
            var id = data["id"].Value<string>();
            if (!_existingObjects.Any(t => t.Id == id) && Template)
            {
                _isCreatingObject = true;
                var prevEnabled = Template.enabled;
                var prevId = Template.Id;
                T go = null;

                // Restored in finally: applying the state can throw - a [Sync] setter of the
                // student's, a value that cannot be read - and the exception leaves through
                // Sync's dispatch, which reports it. Left behind, _isCreatingObject stayed true,
                // so no object created on this client afterwards ever sent its state, and the
                // template kept the remote model's id.
                try
                {
                    Template.enabled = false;
                    Template.Id = id;
                    go = Instantiate(Template);

                    // Templates are often kept switched off in the scene, and a clone starts out
                    // as its template is. A clone that is off never runs Awake: it never registers
                    // for its own updates or with the ticker, so it stayed exactly as this first
                    // update left it - and an object hidden elsewhere (active: false) could never
                    // be shown again. Switched on first, Awake runs and latches the template's
                    // values; the state applied next is then latched too, so none of it is echoed
                    // back, and it decides whether the object ends up visible.
                    if (!go.gameObject.activeSelf)
                        go.gameObject.SetActive(true);

                    // Known before its state is applied, so that a throw there cannot make the
                    // next update for this id build a second object.
                    _existingObjects.Add(go);
                    go.OnModelUpdate(data);
                }
                finally
                {
                    if (go)
                        go.enabled = true;

                    Template.enabled = prevEnabled;
                    Template.Id = prevId;
                    _isCreatingObject = false;
                }
            }
        }

    }
}
