using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The queue between the voice receive thread and the main thread. There can be two receive
    /// threads at once: OnDisable only waits 500 ms for the old one, so after a quick disable and
    /// enable both may be handing packets over while the main thread takes them off.
    /// </summary>
    public class VoicePacketQueueTests
    {
        private GameObject _gameObject;
        private VoiceServerConnection _voice;

        // Edit mode: OnEnable never runs, so there is no socket and no receive thread of its own.
        // The tests are the receive threads.
        [SetUp]
        public void CreateComponent()
        {
            _gameObject = new GameObject("voice-under-test");
            _voice = _gameObject.AddComponent<VoiceServerConnection>();
        }

        [TearDown]
        public void DestroyComponent()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        /// <summary>
        /// The queue used to be a LockFreeQueue, whose node pool is only safe with one producer:
        /// with two, a node can be handed out twice, and packets are lost or delivered twice. That
        /// takes a thread being preempted at one exact instruction, so it cannot be forced on
        /// demand - this did not catch the old queue either. It pins down instead that several
        /// producers, with the main thread taking packets off at the same time, lose and repeat
        /// nothing.
        /// </summary>
        [Test]
        public void PacketsFromSeveralReceiveThreadsAtOnceAreEachDeliveredExactlyOnce()
        {
            const int threads = 4;
            const int packetsPerThread = 30000;

            var delivered = new int[threads + 1, packetsPerThread];
            for (short id = 1; id <= threads; id++)
                _voice.AddVoicePacketListener(id, packet => delivered[packet.Id, packet.Sequence]++);

            var producers = Enumerable.Range(1, threads).Select(id => new Thread(() =>
            {
                for (var sequence = 0; sequence < packetsPerThread; sequence++)
                    _voice.EnqueueReceived(new VoicePacket { Id = (short)id, Sequence = (short)sequence, Codec = Codec.OPUS });
            })).ToArray();

            foreach (var producer in producers)
                producer.Start();

            // The main thread takes packets off while they are still being handed over.
            while (producers.Any(producer => producer.IsAlive))
                _voice.DeliverReceivedPackets();

            foreach (var producer in producers)
                Assert.That(producer.Join(10000), Is.True, "A receive thread never finished");
            _voice.DeliverReceivedPackets();

            var lost = 0;
            var repeated = 0;
            for (var id = 1; id <= threads; id++)
            {
                for (var sequence = 0; sequence < packetsPerThread; sequence++)
                {
                    if (delivered[id, sequence] == 0)
                        lost++;
                    else if (delivered[id, sequence] > 1)
                        repeated++;
                }
            }

            Assert.That((lost, repeated), Is.EqualTo((0, 0)), "Packets were lost or delivered more than once");
        }
    }
}
