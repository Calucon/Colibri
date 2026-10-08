using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Opening the connection's stream: the socket's own without TLS, an encrypted one with it, and
    /// what a server that does not speak TLS looks like to a client that does. The handshake with a
    /// real TLS server is in the PlayMode suite (TlsTests), against colibri-server itself.
    /// </summary>
    public class TlsConnectTests
    {
        private readonly List<IDisposable> _disposables = new List<IDisposable>();

        [TearDown]
        public void CloseSockets()
        {
            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();
        }

        /// <summary>Without TLS the frames go through the socket's own stream, byte for byte.</summary>
        [Test]
        public void WithoutTlsTheStreamIsTheSocketsOwn()
        {
            var listener = Listen();
            var socket = NewSocket();

            var stream = Wait(WebServerConnection.OpenStreamAsync(socket, "127.0.0.1", Port(listener), null, 5000, CancellationToken.None));
            var server = Accept(listener);

            Assert.That(stream, Is.InstanceOf<NetworkStream>());

            stream.Write(new byte[] { 1, 2, 3 }, 0, 3);
            var received = new byte[3];
            Assert.That(server.Receive(received), Is.EqualTo(3));
            Assert.That(received, Is.EqualTo(new byte[] { 1, 2, 3 }));
        }

        /// <summary>
        /// colibri-server without TLS reads the client's TLS hello as a frame it cannot accept and
        /// hangs up. That is said as what it almost always is, a server without TLS, not as a
        /// network error, and not as a certificate problem: no certificate was ever seen.
        /// </summary>
        [Test]
        public void AServerThatHangsUpOnTheHandshakeDidNotAnswerIt()
        {
            var listener = Listen();
            var socket = NewSocket();
            var check = new ServerCertificateCheck("127.0.0.1", false, "");

            var opening = WebServerConnection.OpenStreamAsync(socket, "127.0.0.1", Port(listener), check, 5000, CancellationToken.None);
            var server = Accept(listener);
            server.Receive(new byte[1024]);
            server.Close();

            var e = Assert.Throws<TlsHandshakeException>(() => Wait(opening));

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.NoTlsAnswer));
            Assert.That(e.Message, Does.StartWith($"127.0.0.1:{Port(listener)} did not answer the TLS handshake"));
            Assert.That(check.Rejection, Is.Null);
        }

        /// <summary>A server that answers with something that is not TLS - a plain colibri-server's
        /// refusal, say - is the same case.</summary>
        [Test]
        public void AServerThatAnswersWithoutTlsDidNotAnswerTheHandshake()
        {
            var listener = Listen();
            var socket = NewSocket();

            var opening = WebServerConnection.OpenStreamAsync(socket, "127.0.0.1", Port(listener),
                new ServerCertificateCheck("127.0.0.1", true, ""), 5000, CancellationToken.None);
            var server = Accept(listener);
            server.Receive(new byte[1024]);
            server.Send(Encoding.ASCII.GetBytes("this is not TLS, and it goes on long enough to be read as a record\n"));

            var e = Assert.Throws<TlsHandshakeException>(() => Wait(opening));

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.NoTlsAnswer));
        }

        /// <summary>
        /// A server that accepts the connection and never answers the handshake would hold the
        /// attempt forever. The handshake has the same time as the connection itself - one budget
        /// for both - and giving up closes the socket, as a connect that times out does.
        /// </summary>
        [Test]
        public void AServerThatNeverAnswersTheHandshakeIsGivenUpWithinTheConnectTimeout()
        {
            var listener = Listen();
            var socket = NewSocket();

            var clock = Stopwatch.StartNew();
            var opening = WebServerConnection.OpenStreamAsync(socket, "127.0.0.1", Port(listener),
                new ServerCertificateCheck("127.0.0.1", false, ""), 600, CancellationToken.None);
            Accept(listener);

            var e = Assert.Throws<TlsHandshakeException>(() => Wait(opening));
            clock.Stop();

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.NoTlsAnswer));
            Assert.That(e.Message, Is.EqualTo($"127.0.0.1:{Port(listener)} accepted the connection but did not answer the TLS handshake within 0.6 s"));
            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(500).And.LessThan(5000),
                "The handshake was not given up when the connection's time was up");
            Assert.Throws<ObjectDisposedException>(() => _ = socket.Available, "The abandoned socket was left open");
        }

        [Test]
        public void CancellingGivesUpTheHandshakeAtOnce()
        {
            var listener = Listen();
            var socket = NewSocket();

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var opening = WebServerConnection.OpenStreamAsync(socket, "127.0.0.1", Port(listener),
                    new ServerCertificateCheck("127.0.0.1", false, ""), 60000, cancel.Token);
                Accept(listener);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(opening));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the handshake");
            }
        }


        /*
         *  Helpers
         */

        private TcpListener Listen()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            _disposables.Add(new Stopping(listener));
            return listener;
        }

        private static int Port(TcpListener listener) => ((IPEndPoint)listener.LocalEndpoint).Port;

        private Socket Accept(TcpListener listener)
        {
            var accepting = listener.AcceptSocketAsync();
            Assert.That(accepting.Wait(TimeSpan.FromSeconds(5)), Is.True, "The client never connected");

            var server = accepting.Result;
            server.ReceiveTimeout = 5000;
            _disposables.Add(server);
            return server;
        }

        private Socket NewSocket()
        {
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _disposables.Add(socket);
            return socket;
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
                Assert.Fail("Opening the stream neither succeeded, failed nor gave up within 30 s");

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
