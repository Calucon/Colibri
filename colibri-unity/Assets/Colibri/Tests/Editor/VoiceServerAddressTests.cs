using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The server's voice socket is IPv4 unless VOICE_HOST is an IPv6 address, so out of everything
    /// the server name resolves to, voice goes to an IPv4 address when there is one. It used to take
    /// whichever came first, and on Windows "localhost" usually resolves to ::1 first. A name with
    /// IPv6 addresses only gets its voice sent over IPv6.
    /// </summary>
    public class VoiceServerAddressTests
    {
        private static readonly IPAddress V4 = IPAddress.Parse("192.168.0.10");
        private static readonly IPAddress OtherV4 = IPAddress.Parse("10.0.0.2");
        private static readonly IPAddress V6 = IPAddress.Parse("fe80::1");
        private static readonly IPAddress GlobalV6 = IPAddress.Parse("2001:db8::1");

        [Test]
        public void LocalhostResolvedIPv6FirstStillGivesTheIPv4Loopback()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(new[] { IPAddress.IPv6Loopback, IPAddress.Loopback });

            Assert.That(chosen, Is.EqualTo(IPAddress.Loopback));
        }

        [Test]
        public void TheFirstIPv4AddressIsChosenWhenThereAreSeveral()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(new[] { V6, V4, OtherV4 });

            Assert.That(chosen, Is.EqualTo(V4));
        }

        [Test]
        public void AnIPv4MappedIPv6AddressCountsAsIPv4()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(new[] { V6, V4.MapToIPv6() });

            Assert.That(chosen, Is.EqualTo(V4));
            Assert.That(chosen.AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
        }

        [Test]
        public void AnIPv4AddressWinsOverAnEarlierIPv6Address()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6, V4 }), Is.EqualTo(V4));
        }

        /// <summary>A server whose name has only AAAA records, its IPv4 address being behind carrier-grade NAT, say.</summary>
        [Test]
        public void OnlyIPv6AddressesGiveTheFirstOfThem()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6, IPAddress.IPv6Loopback }), Is.EqualTo(GlobalV6));
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { IPAddress.IPv6Loopback, GlobalV6 }), Is.EqualTo(IPAddress.IPv6Loopback));
        }

        /// <summary>A link-local address names no interface without a scope, so nothing can be sent to it.</summary>
        [Test]
        public void ALinkLocalIPv6AddressWithoutAScopeIsSkipped()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { V6, GlobalV6 }), Is.EqualTo(GlobalV6));
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { V6 }), Is.Null);
        }

        [Test]
        public void ALinkLocalIPv6AddressWithAScopeIsTaken()
        {
            var scoped = IPAddress.Parse("fe80::1%2");

            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { scoped }), Is.EqualTo(scoped));
        }

        [Test]
        public void NoAddressesGiveNothing()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new IPAddress[0]), Is.Null);
            Assert.That(VoiceServerConnection.SelectServerAddress(null), Is.Null);
        }

        /// <summary>The real resolver on this machine, which is where the ::1-first order comes from.</summary>
        [Test]
        public void LocalhostOnThisMachineGivesAnIPv4Loopback()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(Dns.GetHostAddresses("localhost"));

            Assert.That(chosen, Is.Not.Null);
            Assert.That(chosen.AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
            Assert.That(IPAddress.IsLoopback(chosen), Is.True);
        }

        /// <summary>
        /// On the IPv6 loopback, standing in for the server: the socket for an IPv6 server address is
        /// an IPv6 socket, its packet arrives, and the receive thread takes the packet relayed back to
        /// the port it came from, as voice-server.ts relays.
        /// </summary>
        [Test]
        public void VoiceGoesOutAndComesBackOverIPv6()
        {
            var server = OpenIPv6Server();
            var gameObject = new GameObject("voice-under-test");
            try
            {
                var voice = gameObject.AddComponent<VoiceServerConnection>();
                voice.UseAppName("voice-over-ipv6");
                var received = new List<VoicePacket>();
                voice.AddVoicePacketListener(7, received.Add);

                using (var client = VoiceServerConnection.OpenSocket(IPAddress.IPv6Loopback))
                using (var stop = new CancellationTokenSource())
                {
                    Assert.That(client.Client.AddressFamily, Is.EqualTo(AddressFamily.InterNetworkV6));

                    Assert.That(voice.TryEncodeToSend(7, 1, 960, Codec.PCM, new byte[] { 1, 2 }, out var packet), Is.True);
                    client.Send(packet, packet.Length, (IPEndPoint)server.Client.LocalEndPoint);
                    var from = new IPEndPoint(IPAddress.IPv6Any, 0);
                    Assert.That(server.Receive(ref from), Is.EqualTo(packet));

                    var receiving = new Thread(() => voice.Receive(client, stop.Token)) { IsBackground = true };
                    receiving.Start();
                    server.Send(packet, packet.Length, from);

                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (received.Count == 0 && DateTime.UtcNow < deadline)
                    {
                        Thread.Sleep(10);
                        voice.DeliverReceivedPackets();
                    }

                    stop.Cancel();
                    client.Close();
                    Assert.That(receiving.Join(2000), Is.True, "The receive thread did not end when its socket was closed");
                }

                Assert.That(received.Select(p => p.Sequence), Is.EqualTo(new short[] { 1 }), "The relayed packet was not received over IPv6");
            }
            finally
            {
                server.Close();
                Object.DestroyImmediate(gameObject);
            }
        }

        private static UdpClient OpenIPv6Server()
        {
            if (!Socket.OSSupportsIPv6)
                Assert.Ignore("This machine has no IPv6.");

            try
            {
                var server = new UdpClient(new IPEndPoint(IPAddress.IPv6Loopback, 0));
                server.Client.ReceiveTimeout = 5000;
                return server;
            }
            catch (SocketException e)
            {
                Assert.Ignore($"This machine has no IPv6 loopback ({e.SocketErrorCode}).");
                return null;
            }
        }
    }
}
