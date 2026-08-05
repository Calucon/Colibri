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
        private static ColibriConfig _defaults;

        /// <summary>
        /// The project's configuration. Never null: without a configuration asset this hands back
        /// the defaults, so a missing asset surfaces as one clear message from the connection loop
        /// rather than as a NullReferenceException from whichever call site touched it first.
        /// </summary>
        public static ColibriConfig Load()
        {
            if (_instance)
                return _instance;

            // Kept out of _instance so that the asset is picked up the moment it appears - which,
            // in the editor, is as soon as the setup window saves it.
            _instance = Resources.Load<ColibriConfig>("ColibriConfig");
            if (_instance)
                return _instance;

            // Created once, not per call: the connection loop calls Load() every frame, and a
            // ScriptableObject per frame would leak - CreateInstance is not garbage collected.
            if (!_defaults)
            {
                _defaults = CreateInstance<ColibriConfig>();
                _defaults.hideFlags = HideFlags.HideAndDontSave;
            }

            return _defaults;
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
