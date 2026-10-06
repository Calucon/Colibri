using System.Collections;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json.Linq;
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
         *  The end of Play mode, or of the app
         */

        /// <summary>
        /// SyncTicker hands the connection what the send-rate limit was holding as the app quits,
        /// and the connection closes its socket in its own OnDisable a moment later. On Mono and
        /// IL2CPP a socket write completes on a worker thread, so the last update was often still
        /// on its way and was lost with the socket. Quitting now waits briefly for the outbox.
        /// </summary>
        /// <remarks>
        /// Under .NET a small write usually completes inline, so the write still in progress is
        /// staged here: the socket is held, as a write that has not finished holds it, and let go
        /// 30 ms later from another thread.
        /// </remarks>
        [UnityTest]
        public IEnumerator WhatIsStillBeingWrittenWhenTheAppQuitsReachesTheServer()
        {
            _server = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The client never connected", 10f);

            HoldTheSocket(connection, releaseAfterMs: 30);
            SingletonLifetime.IsQuitting = true;
            try
            {
                connection.SendCommand("quit-test", "model::update", new JObject { { "id", "x" }, { "label", "last" } });
                Object.DestroyImmediate(connection.gameObject);
            }
            finally
            {
                // Every later test needs a live application again.
                SingletonLifetime.IsQuitting = false;
            }

            yield return E2EServer.WaitUntil(() => _server.Received.Any(sent => sent.Frame.Channel == "quit-test"),
                "The update sent as the app quit never reached the server", 2f);
        }

        /// <summary>
        /// The wait is bounded: a write that does not finish - a link that has just gone - holds up
        /// the end of Play mode or the app by no more than a brief moment.
        /// </summary>
        [UnityTest]
        public IEnumerator QuittingWaitsOnlyBrieflyForAWriteThatDoesNotFinish()
        {
            _server = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The client never connected", 10f);

            connection.SendLock.Wait();
            SingletonLifetime.IsQuitting = true;
            try
            {
                connection.SendCommand("quit-test", "model::update", new JObject { { "id", "x" }, { "label", "last" } });

                var clock = System.Diagnostics.Stopwatch.StartNew();
                Object.DestroyImmediate(connection.gameObject);

                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(500), "Quitting waited too long for a write that does not finish");
            }
            finally
            {
                SingletonLifetime.IsQuitting = false;
                connection.SendLock.Release();
            }
        }

        /// <summary>
        /// Only the end of the app waits. An ordinary disable closes the socket at once, and what
        /// was still queued goes out after the component is enabled again, on the next connection.
        /// </summary>
        [UnityTest]
        public IEnumerator AnOrdinaryDisableDoesNotWaitAndSendsWhatWasQueuedAfterTheNextEnable()
        {
            _server = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The client never connected", 10f);

            HoldTheSocket(connection, releaseAfterMs: 30);
            connection.SendCommand("disable-test", "broadcast::int", 1);
            connection.enabled = false;

            yield return E2EServer.Settle(0.3f);
            Assert.That(_server.Received.Where(sent => sent.Frame.Channel == "disable-test"), Is.Empty,
                "An ordinary disable waited for the outbox");

            connection.enabled = true;
            yield return E2EServer.WaitUntil(() => _server.Received.Any(sent => sent.Frame.Channel == "disable-test"),
                "What was queued when the component was disabled was not sent after it was enabled again", 10f);

            Assert.That(_server.Received.Single(sent => sent.Frame.Channel == "disable-test").Session, Is.EqualTo(2));
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

        /// <summary>
        /// Holds the socket the way a write that has not finished holds it, and lets go after
        /// <paramref name="releaseAfterMs"/> from another thread - which is where a write completes
        /// on Mono and IL2CPP.
        /// </summary>
        private static void HoldTheSocket(WebServerConnection connection, int releaseAfterMs)
        {
            var sendLock = connection.SendLock;
            sendLock.Wait();
            _ = Task.Run(async () =>
            {
                await Task.Delay(releaseAfterMs).ConfigureAwait(false);
                sendLock.Release();
            });
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
