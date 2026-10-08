#if UNITY_EDITOR
using System;
using System.Reflection;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The Setup window edits a copy of the configuration, and a change reaches the configuration in
    /// use only if Save would accept it. Writing the fields straight into the configuration put a
    /// fingerprint Save refused into Play mode all the same, where every certificate was rejected
    /// for it, and onto disk with the next save of the project's assets.
    /// </summary>
    public class SetupWindowTests
    {
        private const string Sha256 = "57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65:8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7";

        /// <summary>The configuration in use: the asset, in the editor.</summary>
        private ColibriConfig _config;

        /// <summary>The window's copy, which its fields change.</summary>
        private ColibriConfig _edited;

        [SetUp]
        public void CreateConfigs()
        {
            _config = ScriptableObject.CreateInstance<ColibriConfig>();
            _config.name = "ColibriConfig";
            _config.AppName = "setup-window-tests";
            _config.IsSSL = true;

            _edited = ScriptableObject.CreateInstance<ColibriConfig>();
            SetupWindow.CopySettings(_config, _edited);
        }

        [TearDown]
        public void DestroyConfigs()
        {
            Object.DestroyImmediate(_config);
            Object.DestroyImmediate(_edited);
        }

        [Test]
        public void AMalformedFingerprintDoesNotReachTheConfigurationInUse()
        {
            _edited.ServerCertificateSha256 = "AB:CD:XY";

            Assert.That(SetupWindow.ApplyIfValid(_edited, _config), Is.False);
            Assert.That(_config.ServerCertificateSha256, Is.Empty);
        }

        /// <summary>The configuration in use keeps the last valid value until the input is valid again.</summary>
        [Test]
        public void AFingerprintIsAppliedOnceItIsComplete()
        {
            _edited.ServerCertificateSha256 = Sha256.Substring(0, 20);
            SetupWindow.ApplyIfValid(_edited, _config);
            Assert.That(_config.ServerCertificateSha256, Is.Empty, "Half a fingerprint was applied");

            _edited.ServerCertificateSha256 = Sha256;
            Assert.That(SetupWindow.ApplyIfValid(_edited, _config), Is.True);
            Assert.That(_config.ServerCertificateSha256, Is.EqualTo(Sha256));
        }

        /// <summary>Every check Save makes, not only the fingerprint's.</summary>
        [Test]
        public void NoValueThatSaveRefusesIsApplied()
        {
            var refused = new (string What, Action<ColibriConfig> Edit)[]
            {
                ("an empty App Name", config => config.AppName = " "),
                ("an address with a protocol", config => config.ServerAddress = "http://colibri.example.org"),
                ("TCP port 0", config => config.TcpServerPort = 0),
                ("two equal ports", config => config.VoiceServerPort = config.WebServerPort),
                ("a sampling rate of 8000", config => config.VoiceServerSamplingRate = 8000),
                ("a negative send rate", config => config.MaxSendRate = -1),
            };

            var before = JsonUtility.ToJson(_config);
            foreach (var (what, edit) in refused)
            {
                SetupWindow.CopySettings(_config, _edited);
                edit(_edited);

                Assert.That(SetupWindow.ApplyIfValid(_edited, _config), Is.False, what);
                Assert.That(JsonUtility.ToJson(_config), Is.EqualTo(before), $"{what} was applied");
            }
        }

        /// <summary>As before: what the window shows is what Play mode uses, without pressing Save.</summary>
        [Test]
        public void AValidChangeIsAppliedAtOnce()
        {
            _edited.ServerAddress = "192.168.0.10";

            Assert.That(SetupWindow.ApplyIfValid(_edited, _config), Is.True);
            Assert.That(_config.ServerAddress, Is.EqualTo("192.168.0.10"));
        }

        [Test]
        public void EverySettingIsCopiedButNotTheAssetsName()
        {
            _edited.name = "edited";
            _edited.AppName = "another-app";
            _edited.ServerAddress = "192.168.0.10";
            _edited.WebServerPort = 9111;
            _edited.TcpServerPort = 9112;
            _edited.VoiceServerPort = 9113;
            _edited.IsSSL = true;
            _edited.AllowSelfSignedCertificate = true;
            _edited.ServerCertificateSha256 = Sha256;
            _edited.VoiceServerSamplingRate = 16000;
            _edited.MaxSendRate = 0;

            Assert.That(SetupWindow.ApplyIfValid(_edited, _config), Is.True);

            foreach (var field in typeof(ColibriConfig).GetFields(BindingFlags.Public | BindingFlags.Instance))
                Assert.That(field.GetValue(_config), Is.EqualTo(field.GetValue(_edited)), field.Name);
            Assert.That(_config.name, Is.EqualTo("ColibriConfig"), "The asset's name has to stay the file's");
        }
    }
}
#endif
