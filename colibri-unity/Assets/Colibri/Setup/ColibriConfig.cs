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

        /// <summary>
        /// App names that many people end up with: "myAppName" is what every sample, the docs and
        /// the web client's examples use, and the others are what anyone types first. Lowercase;
        /// compared without regard to case.
        /// </summary>
        private static readonly string[] CommonAppNames =
        {
            "myappname", "myapp", "appname", "app", "test", "testapp", "demo", "example", "colibri", "default"
        };

        /// <summary>
        /// Why <paramref name="appName"/> is likely to be shared with strangers, or null if it is
        /// not. An empty name is not this method's concern - see <see cref="IsConfigured"/>.
        /// </summary>
        /// <remarks>
        /// The server puts every client with the same app name into one app, whoever they are. So
        /// everyone in a class who keeps the sample's name sees everyone else's objects and
        /// messages, and since each update goes to every other client in the app, the server's
        /// work grows with the square of their number. Nothing says so at runtime: it just works,
        /// for everyone at once.
        /// </remarks>
        internal static string SharedAppNameWarning(string appName)
        {
            if (string.IsNullOrWhiteSpace(appName))
                return null;

            var name = appName.Trim();
            if (System.Array.IndexOf(CommonAppNames, name.ToLowerInvariant()) < 0)
                return null;

            return $"'{name}' is an App Name other people use too - the samples and the documentation use 'myAppName'. "
                + "Everyone on this server with the same App Name is in one app: they all see each other's objects and messages, "
                + "and the server's work grows with the square of their number. Choose a name of your own, such as your group and project.";
        }

        public string AppName = "";
        public string ServerAddress = "colibri.hci.uni-konstanz.de";
        public int WebServerPort = 9011;
        public int TcpServerPort = 9012;
        public int VoiceServerPort = 9013;
        public bool IsSSL = false;
        public int VoiceServerSamplingRate = 48000;

        /// <summary>The value <see cref="MaxSendRate"/> starts out with.</summary>
        public const int DEFAULT_MAX_SEND_RATE = 30;

        /// <summary>
        /// The most updates per second one synced object sends, 0 for no limit. What
        /// <c>SyncSettings.MaxSendRate</c> starts out as - see there for what the limit does.
        /// </summary>
        /// <remarks>
        /// A configuration asset saved before this field existed has no value for it, and Unity
        /// leaves such a field at its initializer. So existing projects get the default without
        /// saving their configuration again.
        /// </remarks>
        public int MaxSendRate = DEFAULT_MAX_SEND_RATE;

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
