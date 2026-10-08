using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The model::request a listener sends, as the server reads it. A request for one object is
    /// either fresh - the object is in this client's scene now, or being created - or, after a
    /// reconnect, a request again, with <c>again: true</c>, for an object this client held before
    /// the outage. The server treats the two differently when another client has deleted the
    /// object: a fresh request brings the id back into use, a request again is answered with the
    /// delete. Sent fresh after a reconnect, it used to bring back an object deleted while this
    /// client was offline.
    /// </summary>
    public class ModelRequestTests
    {
        private static int _channelCounter;

        private readonly List<IDisposable> _disposables = new List<IDisposable>();
        private readonly List<Action> _cleanup = new List<Action>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var undo in _cleanup)
                undo();
            _cleanup.Clear();

            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();

            // Registering a listener creates the connection singleton - in edit mode an inert
            // component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
                Object.DestroyImmediate(connection.gameObject);
        }

        private static string NewChannel() => $"model-request-test-{++_channelCounter}";

        private void Listen(string channel, Action<JObject> listener, string id = null)
        {
            if (id == null)
                Sync.AddModelUpdateListener(channel, listener);
            else
                Sync.AddModelUpdateListener(channel, listener, id);

            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, listener));
        }

        [Test]
        public void ARequestWhenAListenerRegistersIsFresh()
        {
            var channel = NewChannel();
            Listen(channel, _ => { }, "door");
            Listen(channel, _ => { });

            Assert.That(Requests(channel), Is.EqualTo(new[] { "{\"id\":\"door\"}", "null" }));
        }

        [Test]
        public void ARequestAfterAReconnectSaysItIsARequestAgain()
        {
            var channel = NewChannel();
            Listen(channel, _ => { }, "door");
            Listen(channel, _ => { });

            Sync.RequestModelsAgain();

            Assert.That(Requests(channel), Is.EqualTo(new[]
            {
                "{\"id\":\"door\"}",
                "null",
                "{\"id\":\"door\",\"again\":true}",
                "null",
            }), "Only the request for one object says again; the request for every model on the channel is the same as before");
        }


        /*
         *  Helpers
         */

        /// <summary>
        /// The payloads of the model::requests sent on <paramref name="channel"/> so far, in order:
        /// connects the queue to a loopback session, as a reconnect does, and reads everything it
        /// is sent, up to an end marker queued last.
        /// </summary>
        private List<string> Requests(string channel)
        {
            var connection = WebServerConnection.Instance;
            connection.SendCommand("model-request-test-end", "end", null);

            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Socket server;
            try
            {
                var client = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                _disposables.Add(client);
                client.Connect((IPEndPoint)listener.LocalEndpoint);

                server = listener.AcceptSocket();
                _disposables.Add(server);
                server.ReceiveTimeout = 5000;

                var session = new CancellationTokenSource();
                _disposables.Add(session);
                _cleanup.Add(connection.CloseOutbox);
                connection.OpenOutbox(client, session.Token);
            }
            finally
            {
                listener.Stop();
            }

            var reader = new FrameReader();
            var frames = new List<DecodedFrame>();
            var buffer = new byte[4096];
            while (!frames.Any(frame => frame.Channel == "model-request-test-end"))
            {
                var received = server.Receive(buffer);
                Assert.That(received, Is.GreaterThan(0), "The session was closed before the queued messages had all arrived");
                frames.AddRange(reader.Append(new ReadOnlySpan<byte>(buffer, 0, received)));
            }

            return frames
                .Where(frame => frame.Channel == channel && frame.Command == "model::request")
                .Select(frame => frame.Payload == null || frame.Payload.Length == 0 ? "null" : Encoding.UTF8.GetString(frame.Payload))
                .ToList();
        }
    }
}
