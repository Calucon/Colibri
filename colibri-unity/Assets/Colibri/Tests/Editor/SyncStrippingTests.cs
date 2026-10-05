using System.Reflection;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine.Scripting;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// [Sync] members are only ever reached through reflection, so in a player build with managed
    /// code stripping above Minimal nothing would stop the Unity linker from removing them - and a
    /// SyncTransform whose Position property has been stripped syncs nothing, without an error.
    /// What protects them is that the linker sees a PreserveAttribute on every one.
    /// </summary>
    public class SyncStrippingTests
    {
        [Test]
        public void SyncIsAPreserveAttribute()
        {
            Assert.That(typeof(PreserveAttribute).IsAssignableFrom(typeof(SyncAttribute)), Is.True,
                "[Sync] no longer derives from UnityEngine.Scripting.PreserveAttribute, so stripping can remove synced members");
        }

        [TestCase("Active")]
        [TestCase("Position")]
        [TestCase("Rotation")]
        [TestCase("Scale")]
        [TestCase("PhysicsId")]
        public void EverySyncTransformMemberIsMarkedForPreservation(string propertyName)
        {
            var property = typeof(SyncTransform).GetProperty(propertyName, BindingFlags.Public | BindingFlags.Instance);

            Assert.That(property, Is.Not.Null);
            Assert.That(property.IsDefined(typeof(PreserveAttribute), true), Is.True);
        }
    }
}
