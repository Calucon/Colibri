using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class GenericSyncTransform<T> : SyncBehaviour<T> where T : SyncBehaviour<T>
    {
        [Sync]
        public Vector3 Position
        {
            get
            {
                if (SyncPosition) return transform.position;
                return Vector3.zero;
            }
            set
            {
                if (SyncPosition) transform.position = value;
            }
        }

        public bool SyncPosition = true;

        [Sync]
        public Quaternion Rotation
        {
            get
            {
                if (SyncRotation) return transform.rotation;
                return Quaternion.identity;
            }
            set
            {
                if (SyncRotation) transform.rotation = value;
            }
        }

        public bool SyncRotation = true;

        [Sync]
        public Vector3 Scale
        {
            get
            {
                if (SyncScale) return transform.localScale;
                return Vector3.one;
            }
            set
            {
                if (SyncScale) transform.localScale = value;
            }
        }

        public bool SyncScale = true;


        private string clientPhysicsId = System.Guid.NewGuid().ToString();

        [Sync]
        public string PhysicsId
        {
            get
            {
                if (PhysicsAuthority) _physicsId = clientPhysicsId;
                return _physicsId;
            }
            set
            {
                _physicsId = value;
                PhysicsAuthority = _physicsId == clientPhysicsId;
            }
        }
        private string _physicsId;

        [Header("Physics")]
        public bool PhysicsAuthority = false;
        public bool isKinematic;

        private new Rigidbody rigidbody;

        void Start()
        {
            rigidbody = GetComponent<Rigidbody>();
        }

        void FixedUpdate()
        {
            if (rigidbody)
            {
                if (PhysicsAuthority)
                    rigidbody.isKinematic = isKinematic;
                else
                    rigidbody.isKinematic = true;
            }
        }
    }
}