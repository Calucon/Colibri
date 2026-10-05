using System.Net;
using System.Net.Sockets;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Voice goes out over an IPv4 UDP socket to a server that only listens on IPv4, so out of
    /// everything the server name resolves to, it has to send to an IPv4 address. It used to take
    /// whichever came first - and on Windows "localhost" usually resolves to ::1 first.
    /// </summary>
    public class VoiceServerAddressTests
    {
        private static readonly IPAddress V4 = IPAddress.Parse("192.168.0.10");
        private static readonly IPAddress OtherV4 = IPAddress.Parse("10.0.0.2");
        private static readonly IPAddress V6 = IPAddress.Parse("fe80::1");

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
        public void OnlyIPv6AddressesGiveNothing()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { IPAddress.IPv6Loopback, V6 }), Is.Null);
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
    }
}
