using System;
using UnityEngine.Scripting;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Marks a field or property of a <see cref="SyncBehaviour{T}"/> for synchronization.
    /// </summary>
    /// <remarks>
    /// Derives from <see cref="PreserveAttribute"/> because a [Sync] member is only ever reached
    /// through reflection, so no code references it - which is exactly what managed code
    /// stripping removes once the Managed Stripping Level is raised above Minimal (the IL2CPP
    /// default). The Unity linker honours subclasses of PreserveAttribute, and on a property it
    /// keeps the getter and setter as well.
    /// </remarks>
    [AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
    public class SyncAttribute : PreserveAttribute
    {
        public SyncAttribute()
        {
        }
    }
}
