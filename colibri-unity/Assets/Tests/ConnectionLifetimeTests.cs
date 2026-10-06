using System.Collections;
using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The connection component's own lifetime: what it does with a configuration it cannot use,
    /// and what happens when it is disabled, destroyed, or torn down with the app.
    ///
    /// Like <see cref="ProtocolMismatchDetectionTests"/>, these point the connection singleton at a
    /// <see cref="FakeColibriServer"/>, so they own its lifetime and put it back afterwards.
    /// </summary>
    public class ConnectionLifetimeTests
    {
        private FakeColibriServer _server;

        [UnitySetUp]
        public IEnumerator ReplaceTheConnection()
        {
            yield return DestroyConnection();
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            _server?.Dispose();
            _server = null;

            // Pointed at the real server and freshly built, the way the rest of the suite expects
            // to find it.
            yield return DestroyConnection();
            E2EServer.Configure();

            LogAssert.ignoreFailingMessages = false;
        }


        /*
         *  A configuration the connection cannot use
         */

        /// <summary>
        /// An App Name of spaces is no App Name: the setup and status windows say the project is not
        /// configured. The connection used to disagree - it connected, as an app of its own that no
        /// other client is in, and said nothing. It now says it is not configured, once, and waits
        /// for a real name, which it connects with as soon as there is one.
        /// </summary>
        [UnityTest]
        public IEnumerator AnAppNameOfSpacesIsNotConfiguredAndConnectsNowhere()
        {
            _server = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);

            var notConfigured = 0;
            Application.LogCallback countNotConfigured = (message, stackTrace, type) =>
            {
                if (type == LogType.Error && message == ColibriConfig.NOT_CONFIGURED_MESSAGE)
                    Interlocked.Increment(ref notConfigured);
            };

            Application.logMessageReceivedThreaded += countNotConfigured;
            try
            {
                // Logged by the connection loop, off the main thread; counted above instead.
                LogAssert.ignoreFailingMessages = true;

                var connection = ConnectionTo(_server.Port, appName: "   ");

                // Three of the loop's half-second polls.
                yield return E2EServer.Settle(1.5f);

                Assert.That(_server.Accepted, Is.Zero, "An App Name of spaces was used to connect");
                Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Disconnected));
                Assert.That(notConfigured, Is.EqualTo(1), "Not being configured should be said exactly once");

                ColibriConfig.Load().AppName = E2EServer.App;
                yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                    "The connection did not connect once the App Name was set", 10f);
            }
            finally
            {
                Application.logMessageReceivedThreaded -= countNotConfigured;
            }
        }


        /*
         *  Driving the connection singleton
         */

        /// <summary>
        /// Points a fresh connection at the given port and hands it back without waiting a frame,
        /// so that a test can subscribe to its events before it raises any.
        /// </summary>
        private static WebServerConnection ConnectionTo(int tcpPort, string appName = null)
        {
            E2EServer.Configure();
            var config = ColibriConfig.Load();
            config.TcpServerPort = tcpPort;
            if (appName != null)
                config.AppName = appName;

            // OnEnable is what reads the config, so the port only takes effect on a fresh
            // instance - which touching Instance after the teardown above creates.
            var connection = WebServerConnection.Instance;
            Assert.That(connection, Is.Not.Null);
            return connection;
        }

        private static IEnumerator DestroyConnection()
        {
            var existing = Object.FindFirstObjectByType<WebServerConnection>();
            if (existing != null)
            {
                // OnDisable cancels the loop and closes the socket; the frame after is what lets
                // the cancelled loop unwind before anything rebuilds it.
                Object.DestroyImmediate(existing.gameObject);
                yield return null;
            }
        }
    }
}
