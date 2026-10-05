#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Net;
using UnityEditor;
using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    /// <summary>
    /// Two Player settings that let an Android build - every Meta Quest build - compile, install
    /// and start normally, and then fail on the headset, where there is no console to say why.
    /// </summary>
    /// <remarks>
    /// Checked after every domain reload - which switching the build target causes too - and
    /// reported as a console warning. The Colibri Setup window (Window -> Colibri Configuration)
    /// shows the same issues, each with a button that fixes it.
    /// </remarks>
    internal static class AndroidSettingsCheck
    {
        internal enum Setting
        {
            /// <summary>Player > Other Settings > Internet Access.</summary>
            InternetAccess,

            /// <summary>Player > Other Settings > Allow downloads over HTTP.</summary>
            AllowDownloadsOverHttp
        }

        internal sealed class Issue
        {
            public readonly Setting Setting;
            public readonly string Message;
            public readonly string FixLabel;
            public readonly Action Fix;

            public Issue(Setting setting, string message, string fixLabel, Action fix)
            {
                Setting = setting;
                Message = message;
                FixLabel = fixLabel;
                Fix = fix;
            }
        }

        /// <summary>The issues of this project, for the given (possibly not yet saved) configuration.</summary>
        internal static List<Issue> FindIssues(ColibriConfig config)
        {
            return FindIssues(
                EditorUserBuildSettings.activeBuildTarget,
                config.ServerAddress,
                config.IsSSL,
                PlayerSettings.insecureHttpOption,
                EditorUserBuildSettings.development,
                PlayerSettings.Android.forceInternetPermission);
        }

        internal static List<Issue> FindIssues(BuildTarget target, string serverAddress, bool isSsl,
            InsecureHttpOption httpOption, bool developmentBuild, bool forceInternetPermission)
        {
            var issues = new List<Issue>();
            if (target != BuildTarget.Android)
                return issues;

            if (!forceInternetPermission)
            {
                issues.Add(new Issue(
                    Setting.InternetAccess,
                    "Internet Access is set to Auto. Colibri connects to the server with plain sockets, and an Android app "
                    + "may only open one with the INTERNET permission - which Auto only adds when Unity detects a networking "
                    + "API it knows about. A release build without it starts normally and never connects, and only logcat "
                    + "says why. Set Project Settings > Player > Android > Other Settings > Internet Access to Require.",
                    "Set Internet Access to Require",
                    () => PlayerSettings.Android.forceInternetPermission = true));
            }

            if (!isSsl && !string.IsNullOrWhiteSpace(serverAddress) && !IsLoopback(serverAddress)
                && !AllowsHttp(httpOption, developmentBuild))
            {
                issues.Add(new Issue(
                    Setting.AllowDownloadsOverHttp,
                    $"Allow downloads over HTTP is '{Describe(httpOption)}', but the Colibri server is reached over plain "
                    + $"http://{serverAddress.Trim()} (SSL is off in the Colibri configuration). Unity refuses every such request "
                    + "with \"Insecure connection not allowed\", so Store calls fail on the headset. Set Project Settings > "
                    + "Player > Other Settings > Allow downloads over HTTP to Always allowed - or turn SSL on if the server "
                    + "supports it.",
                    "Allow downloads over HTTP",
                    () => PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed));
            }

            return issues;
        }

        private static bool AllowsHttp(InsecureHttpOption option, bool developmentBuild)
        {
            switch (option)
            {
                case InsecureHttpOption.AlwaysAllowed:
                    return true;
                case InsecureHttpOption.DevelopmentOnly:
                    return developmentBuild;
                default:
                    return false;
            }
        }

        /// <summary>
        /// Unity lets plain HTTP through to localhost whatever the setting says. On a headset that
        /// is the headset itself, but that is a different mistake from this one.
        /// </summary>
        private static bool IsLoopback(string serverAddress)
        {
            var host = serverAddress.Trim();
            if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
                return true;

            return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
        }

        private static string Describe(InsecureHttpOption option)
        {
            switch (option)
            {
                case InsecureHttpOption.NotAllowed:
                    return "Not allowed";
                case InsecureHttpOption.DevelopmentOnly:
                    return "Allowed in development builds";
                default:
                    return option.ToString();
            }
        }


        [InitializeOnLoadMethod]
        private static void CheckAfterReload()
        {
            // Deferred: the configuration is loaded through Resources, which is not reliably
            // available while the domain is still being set up.
            EditorApplication.delayCall += LogIssues;
        }

        internal static void LogIssues()
        {
            foreach (var issue in FindIssues(ColibriConfig.Load()))
                Debug.LogWarning($"Colibri (Android build): {issue.Message}\nWindow -> Colibri Configuration can fix this with one click.");
        }
    }
}
#endif
