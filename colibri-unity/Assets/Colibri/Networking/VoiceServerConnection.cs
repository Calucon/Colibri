using System;
using System.Collections;
using System.Collections.Concurrent;
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

        // Receive thread in, main thread out - and there can be two receive threads at once:
        // OnDisable waits only 500 ms for the old one, so after a quick disable and enable it may
        // still be handing over a packet while the new one starts. A ConcurrentQueue, because the
        // LockFreeQueue this used to be loses or duplicates items with more than one producer.
        // Per instance rather than static, so a new connection never delivers an old one's packets.
        private readonly ConcurrentQueue<VoicePacket> queuedVoicePackets = new ConcurrentQueue<VoicePacket>();
        private readonly Dictionary<int, List<Action<VoicePacket>>> voicePacketListeners = new Dictionary<int, List<Action<VoicePacket>>>();
        private bool isConnected = false;


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

        /// <summary>Hands a received packet to the main thread, where <see cref="Update"/> delivers it.</summary>
        /// <remarks>Called from the receive thread; internal so the EditMode tests can be several of them.</remarks>
        internal void EnqueueReceived(VoicePacket packet) => queuedVoicePackets.Enqueue(packet);

        /// <remarks>Internal so the EditMode tests can drive it without a player loop.</remarks>
        internal void DeliverReceivedPackets()
        {
            while (queuedVoicePackets.TryDequeue(out var packet))
                Invoke(packet);
        }

        private void Connect()
        {
            var host = ColibriConfig.Load().ServerAddress;
            var address = ResolveServerAddress(host);
            if (address != null)
            {
                sendIPEndPoint = new IPEndPoint(address, ColibriConfig.Load().VoiceServerPort);

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
