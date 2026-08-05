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
        private static LockFreeQueue<VoicePacket> queuedVoicePackets = new LockFreeQueue<VoicePacket>();
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
            {
                while (queuedVoicePackets.Dequeue(out var packet))
                {
                    Invoke(packet);
                }
            }
        }

        private void Connect()
        {
            var ip = Dns.GetHostEntry(ColibriConfig.Load().ServerAddress);
            if (ip.AddressList.Length > 0)
            {
                sendIPEndPoint = new IPEndPoint(ip.AddressList[0], ColibriConfig.Load().VoiceServerPort);

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
                Debug.LogError($"Could not resolve {ColibriConfig.Load().ServerAddress}");
                enabled = false;
            }
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
                        queuedVoicePackets.Enqueue(voicePacket);
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
