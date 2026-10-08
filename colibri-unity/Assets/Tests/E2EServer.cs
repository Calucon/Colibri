using System;
using System.Collections;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// Where the tests find a colibri-server, and how Colibri gets pointed at it.
    ///
    /// The environment contract is deliberately the same one colibri-web's e2e suite uses
    /// (<c>colibri-web/e2e/globalSetup.ts</c>), so one exported variable configures both suites
    /// against the same server.
    /// </summary>
    public static class E2EServer
    {
        public static string Host => Env("COLIBRI_E2E_SERVER", "127.0.0.1");

        /// <summary>HTTP and Socket.IO, which the Store's REST calls go through.</summary>
        public static int WebPort => EnvPort("COLIBRI_E2E_PORT", 9011);

        /// <summary>The binary v3 port, which is the one Unity actually speaks.</summary>
        public static int TcpPort => EnvPort("COLIBRI_E2E_TCP_PORT", 9012);

        /// <summary>
        /// The binary port of a second server, with TLS turned on, for <see cref="TlsTests"/>: the
        /// one in <c>colibri-unity/tls-test-server</c>, which run-tests.mjs starts. Same host.
        /// </summary>
        public static int TlsTcpPort => EnvPort("COLIBRI_E2E_TLS_TCP_PORT", 9112);

        /// <summary>That server's web port, https.</summary>
        public static int TlsWebPort => EnvPort("COLIBRI_E2E_TLS_PORT", 9111);

        /// <summary>
        /// That server's certificate, as PEM. By default the one in <c>tls-test-server</c>, found
        /// from the project directory, which is the Editor's working directory.
        /// </summary>
        public static string TlsCertificatePath
            => Env("COLIBRI_E2E_TLS_CERT", Path.Combine(Directory.GetCurrentDirectory(), "tls-test-server", "cert.pem"));

        /// <summary>
        /// One app name for the whole run, not one per test.
        ///
        /// The client is a scene singleton that handshakes once per session and only re-reads the
        /// app name when it reconnects, so changing it between tests would leave the connection on
        /// the old app while the peers joined the new one. Tests isolate themselves with
        /// <see cref="Channel"/> instead. The timestamp keeps concurrent runs, and reruns against a
        /// shared server, from seeing each other's traffic.
        /// </summary>
        public static readonly string App = $"colibri-unity-e2e-{DateTime.UtcNow.Ticks}";

        private static int _channelCounter;

        /// <summary>A channel name no other test in this run will use.</summary>
        public static string Channel(string prefix = "chan") => $"{prefix}-{++_channelCounter}";

        /// <summary>
        /// Skips rather than fails when there is no server. A missing server means the suite could
        /// not run, which is a different thing from Colibri being broken, and reporting it as a
        /// failure would train people to ignore a red suite.
        /// </summary>
        public static void RequireReachable()
        {
            if (IsReachable())
                return;

            Assert.Ignore(
                $"No colibri-server on {Host}:{TcpPort}. Start one with `docker compose up -d` in colibri-server, "
                + "or point the suite at a running one with COLIBRI_E2E_SERVER / COLIBRI_E2E_TCP_PORT.");
        }

        /// <summary>
        /// Skips rather than fails when there is no TLS-enabled server, as <see cref="RequireReachable"/>
        /// does for the plain one.
        /// </summary>
        public static void RequireTlsServer()
        {
            if (!IsReachable(TlsTcpPort))
            {
                Assert.Ignore(
                    $"No colibri-server with TLS on {Host}:{TlsTcpPort}. run-tests.mjs starts one; to start it by hand, "
                    + "`docker compose -f colibri-unity/tls-test-server/compose.yml up -d --build`, or point the suite at one "
                    + "with COLIBRI_E2E_TLS_TCP_PORT, COLIBRI_E2E_TLS_PORT and COLIBRI_E2E_TLS_CERT.");
            }

            if (!File.Exists(TlsCertificatePath))
                Assert.Ignore($"The TLS test server's certificate is not at {TlsCertificatePath}; set COLIBRI_E2E_TLS_CERT.");
        }

        /// <summary>
        /// The SHA-256 fingerprint of the TLS test server's certificate, worked out here from the
        /// PEM file rather than by the code under test, and written without colons in lower case,
        /// which a pin has to accept as well.
        /// </summary>
        public static string TlsCertificateSha256
        {
            get
            {
                var pem = File.ReadAllText(TlsCertificatePath);
                var begin = pem.IndexOf("-----BEGIN CERTIFICATE-----", StringComparison.Ordinal);
                var end = pem.IndexOf("-----END CERTIFICATE-----", StringComparison.Ordinal);
                var body = pem.Substring(begin + "-----BEGIN CERTIFICATE-----".Length, end - begin - "-----BEGIN CERTIFICATE-----".Length);
                var der = Convert.FromBase64String(body.Replace("\r", "").Replace("\n", "").Trim());

                using (var sha256 = System.Security.Cryptography.SHA256.Create())
                    return BitConverter.ToString(sha256.ComputeHash(der)).Replace("-", "").ToLowerInvariant();
            }
        }

        private static bool IsReachable() => IsReachable(TcpPort);

        private static bool IsReachable(int port)
        {
            try
            {
                using (var probe = new TcpClient())
                    return probe.ConnectAsync(Host, port).Wait(TimeSpan.FromSeconds(2));
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Points Colibri at the test server.
        /// </summary>
        /// <remarks>
        /// Mutates the object <see cref="ColibriConfig.Load"/> hands back rather than writing a
        /// configuration asset into the project. With no asset present that object is the shared
        /// defaults instance, which is exactly what the connection loop reads - and
        /// <c>WebServerConnection.Update</c> re-reads it every frame, so this takes effect even if
        /// something has already touched the connection.
        /// </remarks>
        public static void Configure()
        {
            // Problem I from the 2.0.0 verification: with this off, an unfocused Editor stops
            // running the player loop, so the client silently stops sending and receiving while
            // still reporting itself connected. A batchmode Editor has no focus to lose, but the
            // same suite has to behave when someone runs it from the Test Runner window.
            Application.runInBackground = true;

            var config = ColibriConfig.Load();
            config.AppName = App;
            config.ServerAddress = Host;
            config.WebServerPort = WebPort;
            config.TcpServerPort = TcpPort;
            config.IsSSL = false;
            config.AllowSelfSignedCertificate = false;
            config.ServerCertificateSha256 = "";
        }

        /// <summary>
        /// Points Colibri at the TLS test server, or at <paramref name="tcpPort"/> - a proxy in
        /// front of it, or a server without TLS - with TLS on and the given certificate settings.
        /// </summary>
        public static void ConfigureTls(bool allowSelfSigned, string pin, int tcpPort = 0)
        {
            Configure();

            var config = ColibriConfig.Load();
            config.TcpServerPort = tcpPort > 0 ? tcpPort : TlsTcpPort;
            config.WebServerPort = TlsWebPort;
            config.IsSSL = true;
            config.AllowSelfSignedCertificate = allowSelfSigned;
            config.ServerCertificateSha256 = pin;
        }


        /*
         *  Coroutine helpers. Every wait has to pump frames: inbound messages are dispatched from
         *  WebServerConnection.Update, so a test that blocks the main thread waits forever.
         */

        public static IEnumerator WaitUntil(Func<bool> condition, string message, float timeoutSeconds = 10f)
        {
            var deadline = Time.realtimeSinceStartup + timeoutSeconds;

            while (!condition())
            {
                if (Time.realtimeSinceStartup > deadline)
                    Assert.Fail($"{message} (waited {timeoutSeconds:0.#} s)");

                yield return null;
            }
        }

        public static IEnumerator Await(Task task, string message, float timeoutSeconds = 10f)
        {
            yield return WaitUntil(() => task.IsCompleted, message, timeoutSeconds);

            if (task.IsFaulted)
                throw task.Exception;
        }

        /// <summary>Pumps frames for a fixed time, for "and then nothing else happened" assertions.</summary>
        public static IEnumerator Settle(float seconds = 0.5f)
        {
            var deadline = Time.realtimeSinceStartup + seconds;
            while (Time.realtimeSinceStartup < deadline)
                yield return null;
        }

        private static string Env(string name, string fallback)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static int EnvPort(string name, int fallback)
            => int.TryParse(Env(name, fallback.ToString()), out var port) ? port : fallback;
    }
}
