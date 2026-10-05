using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// RemoteLogging's own buffer, which fills from <c>Application.logMessageReceivedThreaded</c> -
    /// whichever threads happen to log, at the same time - and holds the lines while there is no
    /// connection to send them on.
    /// </summary>
    public class RemoteLoggingTests
    {
        private GameObject _gameObject;
        private RemoteLogging _logging;

        // Edit mode: the component's OnEnable never runs, so it neither subscribes to the log nor
        // creates a connection. The tests feed it directly.
        [SetUp]
        public void CreateComponent()
        {
            _gameObject = new GameObject("remote-logging-under-test");
            _logging = _gameObject.AddComponent<RemoteLogging>();
        }

        [TearDown]
        public void DestroyComponent()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        /// <summary>
        /// The buffer used to be a LockFreeQueue, whose node pool is only safe with a single
        /// producer. Losing or duplicating a line under contention is a race, so this cannot force
        /// the old failure on demand; it pins down that many loggers at once lose nothing.
        /// </summary>
        [Test]
        public void LinesLoggedFromManyThreadsAtOnceAreAllKeptExactlyOnce()
        {
            const int threads = 8;
            const int linesPerThread = 100;

            using (var start = new ManualResetEventSlim(false))
            {
                var loggers = Enumerable.Range(0, threads).Select(t => new Thread(() =>
                {
                    start.Wait();
                    for (var i = 0; i < linesPerThread; i++)
                        _logging.OnLogMessage($"thread {t} line {i}", "", LogType.Log);
                })).ToArray();

                foreach (var logger in loggers)
                    logger.Start();
                start.Set();
                foreach (var logger in loggers)
                    Assert.That(logger.Join(10000), Is.True, "A logging thread never finished");
            }

            var expected = Enumerable.Range(0, threads)
                .SelectMany(t => Enumerable.Range(0, linesPerThread).Select(i => $"thread {t} line {i}"))
                .OrderBy(line => line)
                .ToArray();

            Assert.That(_logging.BufferedLineCount, Is.EqualTo(threads * linesPerThread));
            Assert.That(_logging.BufferedLines.OrderBy(line => line).ToArray(), Is.EqualTo(expected));
        }

        /// <summary>
        /// Without a connection the lines wait - but not without limit. They used to: against a
        /// server that had refused this client, every line was put back after its send failed,
        /// for good.
        /// </summary>
        [Test]
        public void WithoutAConnectionOnlyTheNewestLinesAreKept()
        {
            for (var i = 1; i <= 1500; i++)
                _logging.OnLogMessage($"line {i}", "", LogType.Log);

            Assert.That(_logging.BufferedLineCount, Is.EqualTo(1000));
            Assert.That(_logging.BufferedLines,
                Is.EqualTo(Enumerable.Range(501, 1000).Select(i => $"line {i}").ToArray()),
                "The oldest lines should go first, and the rest stay in order");
        }

        [Test]
        public void AnErrorKeepsItsStackTrace()
        {
            _logging.OnLogMessage("it broke", "at Somewhere()", LogType.Error);

            Assert.That(_logging.BufferedLines, Is.EqualTo(new[] { "it broke\nat Somewhere()" }));
        }
    }
}
