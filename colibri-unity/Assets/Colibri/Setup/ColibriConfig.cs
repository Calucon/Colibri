using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    public class ColibriConfig : ScriptableObject
    {
        public static readonly string CONFIG_NAME = "ColibriConfig.asset";

        /// <summary>
        /// What to tell someone whose project has no configuration asset yet. Kept here so the
        /// connection loop, the Store and the status window all say exactly the same thing.
        /// </summary>
        public static readonly string NOT_CONFIGURED_MESSAGE =
            "Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name, and press Save Config. " +
            "(Every client that should see each other has to use the same App Name.)";

        private static ColibriConfig _instance;
        private static bool _hasReportedMissingConfig;

        /// <summary>
        /// The project's configuration. Never null: a project without a configuration asset gets
        /// the defaults, so that a missing asset shows up as one clear message rather than as a
        /// NullReferenceException from whichever call site happened to touch it first.
        /// </summary>
        public static ColibriConfig Load()
        {
            if (_instance)
                return _instance;

            _instance = Resources.Load<ColibriConfig>("ColibriConfig");
            if (_instance)
                return _instance;

            if (!_hasReportedMissingConfig)
            {
                _hasReportedMissingConfig = true;
                Debug.LogError(NOT_CONFIGURED_MESSAGE);
            }

            // Not cached in _instance: the asset can appear at any moment while the editor is
            // running, and the very next Load() should pick it up.
            return CreateInstance<ColibriConfig>();
        }

        /// <summary>
        /// A configuration is only usable with an app name: the server routes messages by it, so
        /// an empty one silently isolates the client from every other client.
        /// </summary>
        public bool IsConfigured => !string.IsNullOrWhiteSpace(AppName);

        public string AppName = "";
        public string ServerAddress = "colibri.hci.uni-konstanz.de";
        public int WebServerPort = 9011;
        public int TcpServerPort = 9012;
        public int VoiceServerPort = 9013;
        public bool IsSSL = false;
        public int VoiceServerSamplingRate = 48000;

        /// <summary>
        /// Generates a URL for the WebRequest
        /// </summary>
        /// <param name="endpoint">Server Endpoint. Not leading slash (/) required</param>
        /// <returns></returns>
        public static string GetWebUrl(string endpoint)
        {
            var config = Load();
            var protocol = config.IsSSL ? "https" : "http";
            endpoint = endpoint.TrimStart('/'); // remove leading slash

            var uri = $"{protocol}://{config.ServerAddress}:{config.WebServerPort}/{endpoint}";
            return uri;
        }
    }
}
