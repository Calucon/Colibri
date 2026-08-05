using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;
using System;
using System.Text;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Egress-side tests, ported case-for-case from the server's
    /// <c>test/unit/protocol.test.ts</c> (`encodeMessageFrame validation`). Ingress was
    /// bounds-checked from the start; egress needs to be too, since a frame this client
    /// cannot represent must be dropped as one bad message instead of propagating out of
    /// the write path.
    /// </summary>
    public class FrameCodecTests
    {
        [Test]
        public void ConstantsMatchTheServer()
        {
            Assert.That(FrameCodec.MaxFieldLength, Is.EqualTo(0xFFFF));
            Assert.That(FrameCodec.MaxFrameLength, Is.EqualTo(1024 * 1024 * 5));
            Assert.That((byte)FrameType.Heartbeat, Is.EqualTo(0x00));
            Assert.That((byte)FrameType.Handshake, Is.EqualTo(0x01));
            Assert.That((byte)FrameType.Message, Is.EqualTo(0x02));
        }

        [Test]
        public void ThrowsForAChannelLongerThanTheU16LengthField()
        {
            Assert.Throws<FrameException>(() =>
                FrameCodec.EncodeMessage(new string('c', 0x10000), "cmd", ReadOnlySpan<byte>.Empty));
        }

        [Test]
        public void ThrowsForACommandLongerThanTheU16LengthField()
        {
            Assert.Throws<FrameException>(() =>
                FrameCodec.EncodeMessage("c", new string('x', 0x10000), ReadOnlySpan<byte>.Empty));
        }

        [Test]
        public void ThrowsRatherThanEmittingAFrameTheReaderWouldReject()
        {
            const int maxFrameLength = 1024;

            Assert.Throws<FrameException>(() =>
                FrameCodec.EncodeMessage("c", "cmd", new byte[maxFrameLength], maxFrameLength));
        }

        [Test]
        public void AcceptsAFrameExactlyAtTheLimit()
        {
            const int maxFrameLength = 1024;
            // 1 type + 2 + 1 channel + 2 + 3 command = 9 bytes of overhead.
            var payload = new byte[maxFrameLength - 9];

            var frame = FrameCodec.EncodeMessage("c", "cmd", payload, maxFrameLength);

            var decoded = new FrameReader(maxFrameLength).Append(frame);
            Assert.That(decoded, Is.EqualTo(new[] { DecodedFrame.Message("c", "cmd", payload) }));
        }

        // A u16 length field counts bytes, not chars - getting this wrong only shows up
        // once a non-ASCII channel or command crosses the wire.
        [Test]
        public void LengthPrefixesCountUtf8BytesNotChars()
        {
            var frame = FrameCodec.EncodeMessage("äö", "cmd", ReadOnlySpan<byte>.Empty);

            Assert.That(frame[5], Is.EqualTo(4), "channel length prefix");
            Assert.That(frame[6], Is.EqualTo(0));
        }

        [Test]
        public void RejectsAHandshakeFieldContainingTheSeparator()
        {
            Assert.Throws<FrameException>(() => FrameCodec.EncodeHandshake("2", "app", "na::me"));
            Assert.Throws<FrameException>(() => FrameCodec.EncodeHandshake("2", "a::pp", "name"));
        }

        [Test]
        public void EncodesTheHandshakeBodyAsUtf8SeparatedFields()
        {
            var frame = FrameCodec.EncodeHandshake("2", "myApp", "myClient");
            var body = Encoding.UTF8.GetString(frame, FrameCodec.HeaderSize, frame.Length - FrameCodec.HeaderSize);

            Assert.That(body, Is.EqualTo("2::myApp::myClient"));
        }
    }
}
