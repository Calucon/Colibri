using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Finding the server over TCP: what counts as an IP address, the order a name's addresses are
    /// tried in, how they share the connect timeout, and moving on from one that is refused or does
    /// not answer. While the socket was IPv4, a server name with only IPv6 addresses, or an IPv6
    /// address, could not be reached at all.
    /// </summary>
    public class ServerAddressTests
    {
        private readonly List<IDisposable> _disposables = new List<IDisposable>();

        // The socket of every address an attempt tried, in order.
        private readonly List<Socket> _attempted = new List<Socket>();

        [TearDown]
        public void CloseSockets()
        {
            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();
            _attempted.Clear();
        }


        /*
         *  What counts as an IP address
         */

        [TestCase("192.168.0.10", "192.168.0.10")]
        [TestCase("::1", "::1")]
        [TestCase("[::1]", "::1")]
        [TestCase("2001:db8::1", "2001:db8::1")]
        [TestCase("[2001:db8::1]", "2001:db8::1")]
        public void AnIPAddressIsTakenAsItIs(string host, string expected)
        {
            Assert.That(WebServerConnection.TryParseAddress(host, out var address), Is.True);
            Assert.That(address, Is.EqualTo(IPAddress.Parse(expected)));
        }

        /// <summary>Brackets hold an IPv6 address and nothing else, as in a URL.</summary>
        [TestCase("colibri.example.org")]
        [TestCase("localhost")]
        [TestCase("[colibri.example.org]")]
        [TestCase("[192.168.0.10]")]
        [TestCase("[::1")]
        [TestCase("[]")]
        [TestCase("")]
        [TestCase(null)]
        public void AnythingElseIsNot(string host)
        {
            Assert.That(WebServerConnection.TryParseAddress(host, out var address), Is.False);
            Assert.That(address, Is.Null);
        }

        [Test]
        public void AnIPAddressIsNotLookedUp()
        {
            var resolving = WebServerConnection.ResolveAsync("[::1]", 5000, CancellationToken.None);

            Assert.That(resolving.IsCompleted, Is.True);
            Assert.That(resolving.Result, Is.EqualTo(new[] { IPAddress.IPv6Loopback }));
        }

        /// <summary>The real resolver on this machine, which is where a name's order comes from.</summary>
        [Test]
        public void LocalhostResolvesToLoopbackAddresses()
        {
            var addresses = Wait(WebServerConnection.ResolveAsync("localhost", 5000, CancellationToken.None));

            Assert.That(addresses, Is.Not.Empty);
            Assert.That(addresses.All(IPAddress.IsLoopback), Is.True, string.Join(", ", addresses));
        }


        /*
         *  The order the addresses are tried in
         */

        [Test]
        public void TheAddressesAreTriedInTheOrderTheResolverGaveThem()
        {
            var v6 = IPAddress.Parse("2001:db8::1");
            var v4 = IPAddress.Parse("192.0.2.1");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6, v4 }), Is.EqualTo(new[] { v6, v4 }));
            Assert.That(WebServerConnection.AddressesToTry(new[] { v4, v6 }), Is.EqualTo(new[] { v4, v6 }));
        }

        /// <summary>A resolver may hand out an address once per socket type; trying it again gains nothing.</summary>
        [Test]
        public void AnAddressFoundTwiceIsTriedOnce()
        {
            var v6 = IPAddress.Parse("2001:db8::1");
            var v4 = IPAddress.Parse("192.0.2.1");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6, v6, v4, v6, v4 }), Is.EqualTo(new[] { v6, v4 }));
        }

        [Test]
        public void AnIPv4MappedAddressIsTriedAsTheIPv4AddressItStandsFor()
        {
            var v4 = IPAddress.Parse("192.0.2.1");

            var addresses = WebServerConnection.AddressesToTry(new[] { v4.MapToIPv6() });

            Assert.That(addresses, Is.EqualTo(new[] { v4 }));
            Assert.That(addresses[0].AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
        }


        /*
         *  Looking up a name
         */

        [Test]
        public void ALookupThatDoesNotFinishIsGivenUpAfterTheTimeout()
        {
            var neverCompletes = new TaskCompletionSource<IPAddress[]>().Task;

            var clock = Stopwatch.StartNew();
            var e = Assert.Throws<TimeoutException>(() =>
                Wait(WebServerConnection.WaitForLookupAsync(neverCompletes, "colibri.example.org", 300, CancellationToken.None)));

            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(250).And.LessThan(5000));
            Assert.That(e.Message, Is.EqualTo("colibri.example.org could not be resolved within 0.3 s"));
        }

        [Test]
        public void CancellingGivesUpTheLookupAtOnce()
        {
            var neverCompletes = new TaskCompletionSource<IPAddress[]>().Task;

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var lookup = WebServerConnection.WaitForLookupAsync(neverCompletes, "colibri.example.org", 60000, cancel.Token);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(lookup));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the lookup");
            }
        }

        [Test]
        public void ALookupThatFindsNothingFailsAsHostNotFound()
        {
            var e = Assert.Throws<SocketException>(() =>
                Wait(WebServerConnection.WaitForLookupAsync(Task.FromResult(new IPAddress[0]), "colibri.example.org", 5000, CancellationToken.None)));

            Assert.That(e.SocketErrorCode, Is.EqualTo(SocketError.HostNotFound));
        }


        /*
         *  Sharing the connect timeout
         */

        [Test]
        public void EachAddressGetsAnEqualShareOfTheTimeLeft()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(5000, 2, false), Is.EqualTo(2500));
            Assert.That(WebServerConnection.AttemptTimeoutMs(4500, 3, false), Is.EqualTo(1500));
        }

        [Test]
        public void TheLastAddressGetsAllTheTimeLeft()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(2400, 1, false), Is.EqualTo(2400));
            Assert.That(WebServerConnection.AttemptTimeoutMs(2400, 1, true), Is.EqualTo(2400));
        }

        [Test]
        public void ManyAddressesGetASecondEachButNeverMoreThanIsLeft()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(5000, 8, false), Is.EqualTo(1000));
            Assert.That(WebServerConnection.AttemptTimeoutMs(600, 3, false), Is.EqualTo(600));
        }

        /// <summary>
        /// Windows takes a second or more to report a refused loopback connection, and resolves
        /// localhost to ::1 first, where colibri-server does not listen by default.
        /// </summary>
        [Test]
        public void ALoopbackAddressWithOthersAfterItGetsAQuarterOfASecond()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(5000, 2, true), Is.EqualTo(250));
        }


        /*
         *  Trying the addresses
         */

        /// <summary>
        /// A name with an IPv6 and an IPv4 address for a server that listens on IPv4 only, as
        /// colibri-server does by default: IPv6 is refused, and IPv4 is tried at once, each with a
        /// socket of its own family.
        /// </summary>
        [Test]
        public void ARefusedAddressIsFollowedByTheNextAtOnce()
        {
            RequireIPv6();
            var port = Port(Listen(IPAddress.Loopback));

            LogAssert.Expect(LogType.Log, new Regex(
                $@"^Colibri: no (connection to \[::1\]:{port} \(ConnectionRefused\)|answer from \[::1\]:{port} within [0-9.]+ s), trying 127\.0\.0\.1:{port}$"));

            var clock = Stopwatch.StartNew();
            var (socket, address) = Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.IPv6Loopback, IPAddress.Loopback },
                "localhost", port, 5000, 5000, Attempting, CancellationToken.None));

            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(2000), "The refused address held up the attempt");
            Assert.That(address, Is.EqualTo(IPAddress.Loopback));
            Assert.That(socket.Connected, Is.True);
            Assert.That(_attempted.Select(s => s.AddressFamily), Is.EqualTo(new[] { AddressFamily.InterNetworkV6, AddressFamily.InterNetwork }));
            Assert.That(socket, Is.SameAs(_attempted[1]));
            Assert.That(socket.NoDelay, Is.True);
            Assert.Throws<ObjectDisposedException>(() => _ = _attempted[0].Available, "The refused attempt's socket was left open");
        }

        /// <summary>When every address fails, the last one's error is the one reported.</summary>
        [Test]
        public void EveryAddressRefusedFailsAsARefusal()
        {
            RequireIPv6();
            var port = ClosedPort();

            var e = Assert.Throws<SocketException>(() => Wait(WebServerConnection.ConnectAnyAsync(
                new[] { IPAddress.IPv6Loopback, IPAddress.Loopback }, "localhost", port, 5000, 5000, Attempting, CancellationToken.None)));

            Assert.That(e.SocketErrorCode, Is.EqualTo(SocketError.ConnectionRefused));
            Assert.That(_attempted, Has.Count.EqualTo(2));
            foreach (var socket in _attempted)
                Assert.Throws<ObjectDisposedException>(() => _ = socket.Available, "A failed attempt's socket was left open");
        }

        /// <summary>
        /// An address that nothing answers on, an IPv6 address on a network that does not route
        /// IPv6, say, holds up the attempt only for its share of the time. Here the first address is
        /// a loopback port that never answers, and the second is another loopback address, which
        /// only Linux routes without further setup. The log gives the loopback address's 250 ms
        /// as 0.25 s, as the guide does.
        /// </summary>
        [Test]
        public void AnAddressThatDoesNotAnswerLeavesTimeForTheNext()
        {
            var unanswered = UnansweredPort();
            var other = IPAddress.Parse("127.0.0.2");
            Listen(other, unanswered);

            LogAssert.Expect(LogType.Log, $"Colibri: no answer from 127.0.0.1:{unanswered} within 0.25 s, trying 127.0.0.2:{unanswered}");

            var clock = Stopwatch.StartNew();
            var (_, address) = Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback, other },
                "colibri.example.org", unanswered, 3000, 3000, Attempting, CancellationToken.None));

            Assert.That(address, Is.EqualTo(other));
            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(1500), "The address that does not answer used up the time of the next");
        }

        /// <summary>The timeout names the server address as configured and the time the whole connection had.</summary>
        [Test]
        public void NoAnswerFromAnyAddressIsATimeoutForTheServerAddress()
        {
            var unanswered = UnansweredPort();

            var clock = Stopwatch.StartNew();
            var e = Assert.Throws<TimeoutException>(() => Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback },
                "colibri.example.org", unanswered, 600, 5000, Attempting, CancellationToken.None)));

            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(500).And.LessThan(5000));
            Assert.That(e.Message, Is.EqualTo($"colibri.example.org:{unanswered} did not answer within 5 s"));
            Assert.Throws<ObjectDisposedException>(() => _ = _attempted.Single().Available, "The abandoned socket was left open");
        }

        /// <summary>Cancelling closes the socket of the address being tried, as OnDisable relies on.</summary>
        [Test]
        public void CancellingClosesTheSocketBeingTried()
        {
            var unanswered = UnansweredPort();

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var attempt = WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback }, "colibri.example.org", unanswered,
                    60000, 60000, Attempting, cancel.Token);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(attempt));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the attempt");
                Assert.Throws<ObjectDisposedException>(() => _ = _attempted.Single().Available, "The socket being tried was left open");
            }
        }


        /*
         *  The whole connection
         */

        [Test]
        public void ABracketedIPv6AddressConnectsOverIPv6()
        {
            RequireIPv6();
            var port = Port(Listen(IPAddress.IPv6Loopback));

            var session = Wait(WebServerConnection.OpenSessionAsync("[::1]", port, null, 5000, Attempting, CancellationToken.None));
            _disposables.Add(session.Stream);

            Assert.That(session.Socket.AddressFamily, Is.EqualTo(AddressFamily.InterNetworkV6));
            Assert.That(session.Address, Is.EqualTo(IPAddress.IPv6Loopback));
            Assert.That(session.Socket.Connected, Is.True);
        }

        /// <summary>
        /// localhost against a server on IPv4 only, as colibri-server listens by default, wherever
        /// localhost resolves to ::1 first: here, and on Windows.
        /// </summary>
        [Test]
        public void LocalhostReachesAServerOnTheIPv4LoopbackOnly()
        {
            var port = Port(Listen(IPAddress.Loopback));

            var session = Wait(WebServerConnection.OpenSessionAsync("localhost", port, null, 5000, Attempting, CancellationToken.None));
            _disposables.Add(session.Stream);

            Assert.That(session.Address, Is.EqualTo(IPAddress.Loopback));
            Assert.That(session.Socket.Connected, Is.True);
        }


        /*
         *  Helpers
         */

        private void Attempting(Socket socket)
        {
            _attempted.Add(socket);
            _disposables.Add(socket);
        }

        private static void RequireIPv6()
        {
            if (!Socket.OSSupportsIPv6)
                Assert.Ignore("This machine has no IPv6.");
        }

        private TcpListener Listen(IPAddress address, int port = 0)
        {
            var listener = new TcpListener(address, port);
            try
            {
                listener.Start();
            }
            catch (SocketException e)
            {
                Assert.Ignore($"Cannot listen on {address} here ({e.SocketErrorCode}).");
            }

            _disposables.Add(new Stopping(listener));
            return listener;
        }

        private static int Port(TcpListener listener) => ((IPEndPoint)listener.LocalEndpoint).Port;

        /// <summary>A port nothing listens on, on either loopback.</summary>
        private int ClosedPort()
        {
            var listener = new TcpListener(IPAddress.IPv6Loopback, 0);
            listener.Start();
            var port = Port(listener);
            listener.Stop();
            return port;
        }

        /// <summary>
        /// A loopback port nothing answers on: a listener that never accepts, with its backlog
        /// already full. See ConnectTimeoutTests.UnansweredPort, which this is a copy of.
        /// </summary>
        private int UnansweredPort()
        {
            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                IgnoreNoUnansweredPort();

            var listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _disposables.Add(listener);
            listener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            listener.Listen(0);
            var port = ((IPEndPoint)listener.LocalEndPoint).Port;

            for (var i = 0; i < 16; i++)
            {
                var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                _disposables.Add(probe);
                var connecting = probe.ConnectAsync(IPAddress.Loopback, port);

                bool answered;
                try
                {
                    answered = connecting.Wait(1000);
                }
                catch (AggregateException)
                {
                    break;
                }

                if (answered)
                    continue;

                probe.Close();
                _ = connecting.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                return port;
            }

            IgnoreNoUnansweredPort();
            return 0;
        }

        private static void IgnoreNoUnansweredPort()
        {
            Assert.Ignore("This system refuses a connection to a full backlog instead of leaving it unanswered, "
                + "so there is no port here that never answers.");
        }

        /// <summary>Rethrows what the task failed with, rather than an AggregateException around it.</summary>
        private static T Wait<T>(Task<T> task)
        {
            try
            {
                task.Wait(TimeSpan.FromSeconds(30));
            }
            catch (AggregateException)
            {
                // Rethrown unwrapped below.
            }

            if (!task.IsCompleted)
                Assert.Fail("The attempt neither connected, failed nor gave up within 30 s");

            return task.GetAwaiter().GetResult();
        }

        private sealed class Stopping : IDisposable
        {
            private readonly TcpListener _listener;
            public Stopping(TcpListener listener) => _listener = listener;
            public void Dispose() => _listener.Stop();
        }
    }
}
