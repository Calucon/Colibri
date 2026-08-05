using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The second endpoint every propagation test needs.
    ///
    /// The server excludes the sender from its own broadcasts, so a single Unity client cannot
    /// observe anything it sends - something else has to be on the app. This is a raw v3 client
    /// built on the package's own <see cref="FrameCodec"/> and <see cref="FrameReader"/>, which
    /// keeps the suite to one process and no second Unity instance. It is a C# port of
    /// <c>colibri-server/test/tcp-crosstalk-check.ts</c>, which proved the flow by hand.
    ///
    /// Using Colibri's own codec means a bug in the codec could in principle hide itself by
    /// being symmetrical. That is what the cross-implementation vectors in
    /// <c>ProtocolVectorTests</c> are for; these tests are about the client above the codec.
    /// </summary>
    public sealed class TcpPeer : IDisposable
    {
        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        private readonly TcpClient _client = new TcpClient();
        private readonly FrameReader _reader = new FrameReader();
        private readonly ConcurrentQueue<DecodedFrame> _inbox = new ConcurrentQueue<DecodedFrame>();
        private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();

        /// <summary>Drained from <see cref="_inbox"/> on the main thread, and never discarded, so a
        /// test can assert on ordering and on what else did or did not arrive.</summary>
        private readonly List<DecodedFrame> _received = new List<DecodedFrame>();

        private NetworkStream _stream;
        private int _heartbeats;

        /// <summary>How many heartbeats the server has sent this peer, all of them echoed back.</summary>
        public int Heartbeats => Volatile.Read(ref _heartbeats);

        public IReadOnlyList<DecodedFrame> Received
        {
            get
            {
                Drain();
                return _received;
            }
        }


        public IEnumerator Connect(string name = "e2e-peer")
        {
            yield return E2EServer.Await(ConnectAsync(name), "the raw peer never reached the server");
        }

        private async Task ConnectAsync(string name)
        {
            await _client.ConnectAsync(E2EServer.Host, E2EServer.TcpPort);
            _stream = _client.GetStream();

            // Started before the handshake so the server's first heartbeat is never missed.
            _ = ReadLoop(_lifetime.Token);

            await WriteAsync(FrameCodec.EncodeHandshake("2", E2EServer.App, name), _lifetime.Token);
        }

        public void Send(string channel, string command, JToken payload)
            => Send(channel, command, payload == null ? null : payload.ToString(Newtonsoft.Json.Formatting.None));

        public void Send(string channel, string command, string rawPayload)
        {
            var frame = FrameCodec.EncodeMessage(channel, command,
                rawPayload == null ? Array.Empty<byte>() : Utf8.GetBytes(rawPayload));

            _ = WriteAsync(frame, _lifetime.Token);
        }


        /*
         *  Assertions
         */

        /// <summary>
        /// Waits for one message, hands it to <paramref name="onReceived"/> and consumes it.
        /// Fails with what did arrive, which is almost always the more useful half.
        /// </summary>
        public IEnumerator Expect(string channel, string command, Action<DecodedFrame> onReceived = null,
            float timeoutSeconds = 8f)
        {
            var deadline = Time.realtimeSinceStartup + timeoutSeconds;

            for (; ; )
            {
                Drain();

                var index = _received.FindIndex(f => f.Channel == channel && (command == null || f.Command == command));
                if (index >= 0)
                {
                    var frame = _received[index];
                    _received.RemoveAt(index);
                    onReceived?.Invoke(frame);
                    yield break;
                }

                if (Time.realtimeSinceStartup > deadline)
                    Assert.Fail($"The peer never received '{command ?? "any command"}' on channel '{channel}' "
                        + $"within {timeoutSeconds:0.#} s. It did receive: {Describe()}");

                yield return null;
            }
        }

        /// <summary>Waits out a settling period and fails if anything arrived on the channel.</summary>
        public IEnumerator ExpectNothing(string channel, float seconds = 1f)
        {
            yield return E2EServer.Settle(seconds);

            Drain();
            var stray = _received.Where(f => f.Channel == channel).ToArray();

            Assert.That(stray, Is.Empty,
                $"Expected nothing on channel '{channel}', but the peer received: {string.Join(", ", stray.Select(Summarize))}");
        }

        public static string Text(DecodedFrame frame)
            => Utf8.GetString(frame.Payload ?? Array.Empty<byte>());

        public static JToken Json(DecodedFrame frame)
        {
            var text = Text(frame);
            try
            {
                return JToken.Parse(text);
            }
            catch (Exception)
            {
                Assert.Fail($"The peer received a payload that is not JSON: '{text}'");
                return null;
            }
        }

        public string Describe()
            => _received.Count == 0 ? "nothing" : string.Join(", ", _received.Select(Summarize));

        private static string Summarize(DecodedFrame frame)
            => $"{frame.Channel}/{frame.Command} '{Text(frame)}'";

        private void Drain()
        {
            while (_inbox.TryDequeue(out var frame))
                _received.Add(frame);
        }


        /*
         *  Transport
         */

        private async Task ReadLoop(CancellationToken token)
        {
            var buffer = new byte[16 * 1024];

            while (!token.IsCancellationRequested)
            {
                int read;
                try
                {
                    read = await _stream.ReadAsync(buffer, 0, buffer.Length, token);
                }
                catch (Exception)
                {
                    // Disposed or reset - either way there is nothing left to read.
                    return;
                }

                if (read <= 0)
                    return;

                foreach (var frame in Decode(buffer, read))
                {
                    switch (frame.Type)
                    {
                        case FrameType.Heartbeat:
                            Interlocked.Increment(ref _heartbeats);
                            // Not echoing these gets the peer dropped mid-test, which then shows up
                            // as a message that mysteriously never arrived.
                            await WriteAsync(FrameCodec.EncodeHeartbeat(frame.PingTimestamp), token);
                            break;

                        case FrameType.Message:
                            _inbox.Enqueue(frame);
                            break;
                    }
                }
            }
        }

        /// <summary>
        /// Decoding lives in its own method because <see cref="FrameReader.Append"/> takes a
        /// <c>ReadOnlySpan</c>, which cannot be a local in an async method. The list is copied for
        /// the same reason the reader hands one back: it reuses its own buffer on the next call.
        /// </summary>
        private List<DecodedFrame> Decode(byte[] buffer, int count)
            => new List<DecodedFrame>(_reader.Append(new ReadOnlySpan<byte>(buffer, 0, count)));

        private async Task WriteAsync(byte[] frame, CancellationToken token)
        {
            await _writeLock.WaitAsync(token);
            try
            {
                await _stream.WriteAsync(frame, 0, frame.Length, token);
            }
            catch (Exception)
            {
                // A write that fails during teardown is expected; one that fails mid-test surfaces
                // as the missing message it causes.
            }
            finally
            {
                _writeLock.Release();
            }
        }

        public void Dispose()
        {
            _lifetime.Cancel();

            try
            {
                _stream?.Dispose();
                _client.Close();
            }
            catch (Exception)
            {
                // Nothing useful to do with a failure to close a socket we are discarding.
            }

            _lifetime.Dispose();
            _writeLock.Dispose();
        }
    }
}
