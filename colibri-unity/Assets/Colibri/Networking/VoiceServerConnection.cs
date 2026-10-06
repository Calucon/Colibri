using System;
using System.Collections;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public class VoiceServerConnection : SingletonBehaviour<VoiceServerConnection>
    {
        private UdpClient udpClient;
        private IPEndPoint sendIPEndPoint;
        private IPEndPoint inEndPoint = new IPEndPoint(IPAddress.Any, 0);
        private Thread udpThread;
        private CancellationTokenSource shutdown;

        /// <summary>
        /// The most audio, per sender, that waits for the main thread. Packets keep arriving while
        /// Update does not run - a Quest paused with the headset off, a long scene load - and used
        /// to queue without limit, to be played back all at once, long stale, when it ran again.
        /// Past this the oldest of that sender's packets are dropped. Settable for the tests.
        /// </summary>
        internal float MaxQueuedSeconds = 1f;

        /// <summary>
        /// The shortest audio a packet counts as, in parts of a second: 2.5 ms, Opus's shortest
        /// frame. Only a packet claiming a frame size of zero or less is that short, and this keeps
        /// a stream of those bounded too.
        /// </summary>
        private const int MIN_PACKET_DIVISOR = 400;

        private const int DEFAULT_SAMPLING_RATE = 48000;

        // The voice server's, which a packet's FrameSize is counted in. Written by Connect, on the
        // main thread, before the receive thread starts.
        private volatile int samplingRate = DEFAULT_SAMPLING_RATE;

        // Receive thread in, main thread out - and there can be two receive threads at once:
        // OnDisable waits only 500 ms for the old one, so after a quick disable and enable it may
        // still be handing over a packet while the new one starts. Everything in the queues is
        // under queueLock. Per instance rather than static, so a new connection never delivers an
        // old one's packets.
        private readonly object queueLock = new object();
        private readonly Dictionary<short, SenderQueue> queuedVoicePackets = new Dictionary<short, SenderQueue>();

        // Main thread only: the packets being delivered, taken out of the queues in one go.
        private readonly List<VoicePacket> deliveringPackets = new List<VoicePacket>();

        private readonly Dictionary<int, List<Action<VoicePacket>>> voicePacketListeners = new Dictionary<int, List<Action<VoicePacket>>>();
        private bool isConnected = false;

        private sealed class SenderQueue
        {
            public readonly Queue<VoicePacket> Packets = new Queue<VoicePacket>();

            // The audio in Packets, in samples at the voice server's sampling rate.
            public long Samples;
        }


        private void OnEnable()
        {
            DontDestroyOnLoad(this);
            if (!String.IsNullOrEmpty(ColibriConfig.Load().ServerAddress))
                Connect();
        }

        private void OnDisable()
        {
            isConnected = false;

            // Thread.Abort is unsupported on .NET Core / IL2CPP and would leave the socket in
            // an undefined state anyway. Cancelling and closing the client is what actually
            // unblocks the blocking Receive() the thread is parked in.
            shutdown?.Cancel();

            udpClient?.Close();
            udpClient = null;

            // Every field here is null if Connect() bailed out (or was never reached), which
            // used to make OnDisable throw on udpThread.Abort().
            udpThread?.Join(500);
            udpThread = null;

            shutdown?.Dispose();
            shutdown = null;
        }

        private void Update()
        {
            if (isConnected)
                DeliverReceivedPackets();
        }

        /// <summary>
        /// Hands a received packet to the main thread, where <see cref="Update"/> delivers it,
        /// keeping no more than <see cref="MaxQueuedSeconds"/> of each sender's audio.
        /// </summary>
        /// <remarks>Called from the receive thread; internal so the EditMode tests can be several of them.</remarks>
        internal void EnqueueReceived(VoicePacket packet)
        {
            var rate = samplingRate;
            var maxSamples = (long)(MaxQueuedSeconds * rate);
            var minSamples = rate / MIN_PACKET_DIVISOR;

            lock (queueLock)
            {
                if (!queuedVoicePackets.TryGetValue(packet.Id, out var queue))
                {
                    queue = new SenderQueue();
                    queuedVoicePackets.Add(packet.Id, queue);
                }

                queue.Packets.Enqueue(packet);
                queue.Samples += Math.Max(packet.FrameSize, minSamples);

                // The newest is what is worth playing. The packet just queued always stays.
                while (queue.Samples > maxSamples && queue.Packets.Count > 1)
                    queue.Samples -= Math.Max(queue.Packets.Dequeue().FrameSize, minSamples);
            }
        }

        /// <remarks>Internal so the EditMode tests can drive it without a player loop.</remarks>
        internal void DeliverReceivedPackets()
        {
            lock (queueLock)
            {
                // A struct enumerator, and queues that keep their arrays: nothing allocated per frame.
                foreach (var queue in queuedVoicePackets.Values)
                {
                    while (queue.Packets.Count > 0)
                        deliveringPackets.Add(queue.Packets.Dequeue());
                    queue.Samples = 0;
                }
            }

            // Outside the lock, so a listener never holds up the receive thread.
            try
            {
                foreach (var packet in deliveringPackets)
                    Invoke(packet);
            }
            finally
            {
                deliveringPackets.Clear();
            }
        }

        private void Connect()
        {
            var config = ColibriConfig.Load();
            var host = config.ServerAddress;
            var address = ResolveServerAddress(host);
            if (address != null)
            {
                sendIPEndPoint = new IPEndPoint(address, config.VoiceServerPort);
                samplingRate = config.VoiceServerSamplingRate > 0 ? config.VoiceServerSamplingRate : DEFAULT_SAMPLING_RATE;

                udpClient = new UdpClient();
                // Port 0 lets the OS pick an ephemeral port. The server replies to whatever
                // source port the datagram came from (voice-server.ts), so the hardcoded 9014
                // this used to bind bought nothing and capped a machine at one Unity client.
                udpClient.Client.Bind(new IPEndPoint(IPAddress.Any, 0));

                shutdown = new CancellationTokenSource();
                udpThread = new Thread(Receive)
                {
                    Name = "Voice UDP Thread",
                    IsBackground = true
                };
                udpThread.Start();

                isConnected = true;
            }
            else
            {
                enabled = false;
            }
        }

        /// <summary>
        /// The address to send voice to, or null - having said why - when there is none.
        /// </summary>
        /// <remarks>
        /// GetHostAddresses rather than GetHostEntry: for an IP address it hands the address
        /// straight back, where GetHostEntry first attempts a reverse lookup, which can fail for
        /// a LAN address with no DNS name and threw out of OnEnable.
        /// </remarks>
        private static IPAddress ResolveServerAddress(string host)
        {
            IPAddress[] candidates;
            try
            {
                candidates = Dns.GetHostAddresses(host);
            }
            catch (Exception e) when (e is SocketException || e is ArgumentException)
            {
                Debug.LogError($"Colibri voice: could not resolve the server address '{host}' ({e.Message}). Voice chat is off. Check the address in Window -> Colibri Configuration.");
                return null;
            }

            var address = SelectServerAddress(candidates);
            if (address == null)
            {
                var found = candidates.Length == 0 ? "no addresses at all" : string.Join<IPAddress>(", ", candidates);
                Debug.LogError($"Colibri voice: the server address '{host}' resolved to {found}, but the voice server only listens on IPv4. Voice chat is off. Enter the server's IPv4 address in Window -> Colibri Configuration.");
            }

            return address;
        }

        /// <summary>
        /// Picks the address the voice socket can actually reach, out of everything a name
        /// resolved to.
        /// </summary>
        /// <remarks>
        /// The socket is IPv4 (bound to <see cref="IPAddress.Any"/>), and so is the server's
        /// (voice-server.ts creates a udp4 socket). Taking the first address regardless broke on
        /// Windows, where "localhost" commonly resolves to ::1 before 127.0.0.1: every send from
        /// the IPv4 socket to the IPv6 address threw, and no voice ever reached the server. An
        /// IPv4-mapped IPv6 address is as good as the IPv4 address inside it.
        /// </remarks>
        /// <returns>An IPv4 address, or null when there is none.</returns>
        internal static IPAddress SelectServerAddress(IPAddress[] candidates)
        {
            if (candidates == null)
                return null;

            foreach (var candidate in candidates)
            {
                if (candidate.AddressFamily == AddressFamily.InterNetwork)
                    return candidate;
            }

            foreach (var candidate in candidates)
            {
                if (candidate.AddressFamily == AddressFamily.InterNetworkV6 && candidate.IsIPv4MappedToIPv6)
                    return candidate.MapToIPv4();
            }

            return null;
        }

        private void Receive()
        {
            // Captured locally: OnDisable clears the fields while this thread is still winding down.
            var client = udpClient;
            var token = shutdown.Token;

            while (!token.IsCancellationRequested)
            {
                try
                {
                    byte[] bytes = client.Receive(ref inEndPoint);
                    VoicePacket voicePacket = GetVoicePacket(bytes);
                    if (voicePacket.Id != 0)
                    {
                        EnqueueReceived(voicePacket);
                    }
                }
                catch (ObjectDisposedException)
                {
                    // Client closed by OnDisable - this is the shutdown path.
                    return;
                }
                catch (SocketException e)
                {
                    if (token.IsCancellationRequested)
                        return;

                    // Transient on UDP (an ICMP port-unreachable from a peer surfaces here as
                    // ECONNRESET); keep receiving.
                    Debug.LogWarning($"Colibri voice: {e.SocketErrorCode}");
                }
                catch (Exception e)
                {
                    Debug.Log(e.ToString());
                }
            }
        }

        public void SendByteData(short id, short sequence, short frameSize, Codec codec, byte[] data)
        {
            var client = udpClient;
            if (client == null)
                return;

            byte[] bytes = AddMetadataBytes(id, sequence, frameSize, codec, data);
            client.Send(bytes, bytes.Length, sendIPEndPoint);
        }

        public void AddVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (!voicePacketListeners.ContainsKey(id))
                voicePacketListeners.Add(id, new List<Action<VoicePacket>>());
            voicePacketListeners[id].Add(listener);
        }

        public void RemoveVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (voicePacketListeners.ContainsKey(id))
        {
            var list = voicePacketListeners[id];
            list.Remove(listener);
            if (list.Count == 0)
                voicePacketListeners.Remove(id);
        }
        }

        private void Invoke(VoicePacket voicePacket)
        {
            if (voicePacketListeners.ContainsKey(voicePacket.Id))
            {
                foreach (var voicePacketListener in voicePacketListeners[voicePacket.Id].ToArray())
                    voicePacketListener.Invoke(voicePacket);
            }
        }

        private VoicePacket GetVoicePacket(byte[] data)
        {
            short id = BitConverter.ToInt16(data, 0);
            short sequence = BitConverter.ToInt16(data, 2);
            short frameSize = BitConverter.ToInt16(data, 4);
            Codec codec = (Codec)data[6];
            byte[] sampleData = new byte[data.Length - 7];
            Array.Copy(data, 7, sampleData, 0, sampleData.Length);
            return new VoicePacket() { Id = id, Sequence = sequence, FrameSize = frameSize, Codec = codec, Data = sampleData };
        }

        private byte[] AddMetadataBytes(short id, short sequence, short frameSize, Codec codec, byte[] data)
        {
            byte[] bytes = new byte[data.Length + 7];
            byte[] idBytes = BitConverter.GetBytes(id);
            byte[] sequenceBytes = BitConverter.GetBytes(sequence);
            byte[] frameSizeBytes = BitConverter.GetBytes(frameSize);
            byte codecByte = (byte)codec;
            Array.Copy(idBytes, bytes, 2);
            Array.Copy(sequenceBytes, 0, bytes, 2, 2);
            Array.Copy(frameSizeBytes, 0, bytes, 4, 2);
            bytes[6] = codecByte;
            Array.Copy(data, 0, bytes, 7, data.Length);
            return bytes;
        }
    }
}
