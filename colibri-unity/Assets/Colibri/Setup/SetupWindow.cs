#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HCIKonstanz.Colibri.Networking;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEngine;
using UnityEngine.UIElements;

namespace HCIKonstanz.Colibri.Setup
{
    [InitializeOnLoad]
    public class SetupWindow : EditorWindow
    {
        private static SetupWindow Instance;
        private static bool IsOpen => Instance != null;
        private static bool _waitingToLoad;
        private static bool _portSettings = false;

        private ColibriConfig Config;
        private Vector2 _scroll;

        [DidReloadScripts]
        static void OnReload()
        {
            Init();
        }

        // TODO: this is rather inflexible. Maybe there's a better way to detect the configuration (Resources.Load is not allowed in static methods)?
        private static bool ConfigExists() => File.Exists(Path.Combine(Application.dataPath, "Resources", ColibriConfig.CONFIG_NAME));

        static void Init()
        {
            if (!ConfigExists())
            {
                if (EditorApplication.isCompiling && !_waitingToLoad)
                {
                    _waitingToLoad = true;
                    EditorApplication.update += Init;
                    return;
                }

                if (!EditorApplication.isCompiling)
                {
                    if (_waitingToLoad)
                    {
                        EditorApplication.update -= Init;
                        _waitingToLoad = false;
                    }

                    ShowConfigurationWindow();
                }
            }
        }


        [MenuItem("Window/Colibri Configuration")]
        private static void ShowConfigurationWindow()
        {
            // There should be only one configurator window open as a "pop-up". If already open, then just force focus on our instance
            if (IsOpen)
            {
                Instance.Focus();
            }
            else
            {
                var window = CreateInstance<SetupWindow>();
                window.titleContent = new GUIContent("Colibri Setup", EditorGUIUtility.IconContent("_Popup").image);
                window.position = new Rect(Screen.width / 2.0f, Screen.height / 2.0f, 500, 550);
                window.ShowUtility();
            }
        }

        private void OnEnable()
        {
            Instance = this;

            Config = ColibriConfig.Load();
            if (!ConfigExists())
            {
                // Load() hands back a shared, hidden defaults object when there is no asset yet.
                // That one must not *become* the asset, so this window creates its own to save.
                Config = CreateInstance<ColibriConfig>();
                SaveConfig();
            }
        }

        private void SaveConfig()
        {
            Directory.CreateDirectory(Path.Combine(Application.dataPath, "Resources"));
            string path = Path.Combine("Assets", "Resources", ColibriConfig.CONFIG_NAME);
            if (!ConfigExists())
                AssetDatabase.CreateAsset(Config, path);
            else
            {
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }
        }

        private void OnGUI()
        {
            // The Android section at the bottom can run past the edge of the window.
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            // Stretched to the width there is, not fixed to the window's 500 px: inside the scroll
            // view, a vertical scrollbar takes some of those, and a fixed-width title then added
            // a horizontal one as well.
            GUILayout.Label("Colibri Setup", new GUIStyle(EditorStyles.largeLabel)
            {
                fontSize = 22,
                fontStyle = FontStyle.Bold,
                alignment = TextAnchor.MiddleCenter,
                stretchWidth = true
            });

            GUILayout.Space(15f);

            var logo = AssetDatabase.LoadAssetAtPath<Texture2D>(AssetDatabase.GUIDToAssetPath("997fb65d771f4694f8335970ea4e3916"));
            GUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            GUILayout.Label(logo, GUILayout.MaxHeight(128f));
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();

            GUILayout.Space(15f);
            EditorGUILayout.LabelField("", GUI.skin.horizontalSlider);

            EditorGUILayout.HelpBox("Choose an App Name unique to this project. Every client that should share objects and messages "
                + "must use the same App Name.", MessageType.Info);
            Config.AppName = EditorGUILayout.TextField("App Name: ", Config.AppName);

            var sharedAppName = ColibriConfig.SharedAppNameWarning(Config.AppName);
            if (sharedAppName != null)
                EditorGUILayout.HelpBox(sharedAppName, MessageType.Warning);

            Config.ServerAddress = EditorGUILayout.TextField("Server Address: ", Config.ServerAddress);
            GUILayout.Space(16);
            _portSettings = EditorGUILayout.Foldout(_portSettings, "Optional Config");
            if (_portSettings)
            {
                var x = EditorGUILayout.BeginVertical();
                x.position = new Vector2(5, 5);
                EditorGUILayout.HelpBox("The ports, SSL/TLS and the voice sampling rate must match the server. Change them only "
                    + "if the server does not use the defaults.", MessageType.Warning);
                Config.IsSSL = EditorGUILayout.Toggle(new GUIContent("Server supports SSL/TLS?",
                    "The server has TLS turned on (TLS_CERT and TLS_KEY): the TCP connection is encrypted, and the Store uses https."), Config.IsSSL);
                if (Config.IsSSL)
                {
                    // Only meaningful with TLS, so only shown with it.
                    EditorGUI.indentLevel++;
                    Config.AllowSelfSignedCertificate = EditorGUILayout.Toggle(new GUIContent("Allow self-signed certificate",
                        "Also accept a server certificate this device does not trust, such as a self-signed one. The connection "
                        + "is still encrypted, but nothing checks that it goes to your server."), Config.AllowSelfSignedCertificate);
                    Config.ServerCertificateSha256 = EditorGUILayout.TextField(new GUIContent("Server certificate SHA-256",
                        "Optional. The fingerprint of the one certificate to accept, trusted or not, as colibri-server logs it "
                        + "when it starts; every other certificate is rejected. Leave it empty for a certificate from Let's Encrypt, "
                        + "which changes with every renewal."), Config.ServerCertificateSha256);
                    EditorGUI.indentLevel--;
                }
                Config.WebServerPort = EditorGUILayout.IntField("Web server Port: ", Config.WebServerPort);
                Config.TcpServerPort = EditorGUILayout.IntField("TCP server Port: ", Config.TcpServerPort);
                Config.VoiceServerPort = EditorGUILayout.IntField("Voice server Port: ", Config.VoiceServerPort);
                Config.VoiceServerSamplingRate = EditorGUILayout.IntField("Voice Sampling Rate: ", Config.VoiceServerSamplingRate);
                Config.MaxSendRate = EditorGUILayout.IntField(new GUIContent("Max Send Rate (Hz): ",
                    "The most updates per second one synced object (SyncTransform, SyncBehaviour) sends. "
                    + "Nothing is lost: a single change goes out at once, and the latest values of quicker "
                    + "changes go out when the interval is up. 0 = no limit, one update per frame. "
                    + "Code can change it at runtime through SyncSettings.MaxSendRate."), Config.MaxSendRate);
                EditorGUILayout.EndVertical();
            }

            var errors = new List<string>();

            // The status window's test. A name of spaces only used to pass here, and the status
            // window then reported the project as not configured.
            if (!Config.IsConfigured)
                errors.Add("App Name must not be empty!");
            if (Config.ServerAddress.Contains("://"))
                errors.Add("Server address should not contain a protocol (only IP or domain name)");
            if (Config.WebServerPort <= 0 || Config.WebServerPort > 65535)
                errors.Add("Web server port invalid (must be a number between 1 - 65535, default 9011)");
            if (Config.TcpServerPort <= 0 || Config.TcpServerPort > 65535)
                errors.Add("TCP server port invalid (must be a number between 1 - 65535, default 9012)");
            if (Config.VoiceServerPort <= 0 || Config.VoiceServerPort > 65535)
                errors.Add("Voice server port invalid (must be a number between 1 - 65535, default 9013)");
            if ((new int[] { Config.WebServerPort, Config.TcpServerPort, Config.VoiceServerPort }).Distinct().Count() != 3)
                errors.Add("Two ports may not have the same value!");
            if (Config.VoiceServerSamplingRate < 16000 || Config.VoiceServerSamplingRate > 48000)
                errors.Add("Voice server sampling rate invalid (must be a number between 16000 - 48000, default 48000)");
            if (Config.MaxSendRate < 0)
                errors.Add($"Max send rate invalid (updates per second per synced object; 0 = no limit, default {ColibriConfig.DEFAULT_MAX_SEND_RATE})");
            var certificateError = CertificateSettingsError(Config);
            if (certificateError != null)
                errors.Add(certificateError);

            GUILayout.Space(15f);

            EditorGUI.BeginDisabledGroup(errors.Count != 0);
            if (GUILayout.Button("Save Config"))
            {
                EditorUtility.SetDirty(Config);
                SaveConfig();
                Close();
            }
            EditorGUI.EndDisabledGroup();

            foreach (var error in errors)
                EditorGUILayout.HelpBox(error, MessageType.Error);

            // Outside the foldout: it is closed whenever the window opens, and this is not a
            // setting to forget about.
            if (Config.MaxSendRate == 0)
            {
                EditorGUILayout.HelpBox("Max Send Rate is 0, so there is no limit: every moving synced object sends an update "
                    + "in every frame, 72 to 120 a second on a headset. One server and one Wi-Fi network cannot keep up "
                    + $"with dozens of clients doing that. The default is {ColibriConfig.DEFAULT_MAX_SEND_RATE}.", MessageType.Warning);
            }

            DrawAndroidIssues();

            EditorGUILayout.EndScrollView();
        }

        /// <summary>
        /// What is wrong with the certificate settings, or null. A pinned fingerprint that cannot
        /// match any certificate would have every connection rejected, so it is not saved; without
        /// TLS the settings are not used, and not checked.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static string CertificateSettingsError(ColibriConfig config)
        {
            if (!config.IsSSL || ServerCertificatePolicy.TryNormalizeFingerprint(config.ServerCertificateSha256, out _))
                return null;

            return "Server certificate SHA-256 invalid (64 hexadecimal digits, with or without colons, as colibri-server logs it; or empty)";
        }

        /// <summary>
        /// Settings that break a build silently - see <see cref="AndroidSettingsCheck"/>.
        /// Checked against the configuration as edited here, so turning SSL on clears the HTTP one.
        /// </summary>
        private void DrawAndroidIssues()
        {
            var issues = AndroidSettingsCheck.FindIssues(Config);
            if (issues.Count == 0)
                return;

            GUILayout.Space(15f);
            EditorGUILayout.LabelField(EditorUserBuildSettings.activeBuildTarget == BuildTarget.Android
                ? "Android / Meta Quest"
                : "Player build", EditorStyles.boldLabel);

            foreach (var issue in issues)
            {
                EditorGUILayout.HelpBox(issue.Message, MessageType.Warning);
                if (GUILayout.Button(issue.FixLabel))
                    issue.Fix();
            }
        }
    }
}
#endif
