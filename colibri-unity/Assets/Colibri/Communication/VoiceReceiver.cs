using System.Collections;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Communication
{
    [RequireComponent(typeof(AudioSource))]
    public class VoiceReceiver : MonoBehaviour
    {
        public bool FastForwardPlayback = true;
        public int FastForwardLatencyMilliseconds = 100;
        // Kept so that scripts that set it still compile.
        [Tooltip("No effect. Each packet is decoded by its own codec; Use Opus Codec on VoiceBroadcast decides what a client sends.")]
        public bool UseOpusCodec = false;
        public int FrameSizeMilliseconds = 20;
        public float Volume = 1f;

        // Debug
        public bool Debugging = false;
        private static readonly string DEBUG_HEADER = "[VoiceReceiver] ";
        private float timer = 0.0f;

        // Playback audio
        private int serverSamplingRate = 48000;
        private int frameSize = 960;
        private AudioSource playbackAudioSource;
        private List<float> playbackBuffer;
        private VoiceServerConnection voiceServerConnection;
        private short remoteUserId;
        private bool playback = false;
        // private bool isInitialized = false;
        private Resampler resampler;
        private int fastForwardSamplesThreshold = 4800;

        // Decodes each packet by its codec, creating opusDecoder with the first Opus packet
        private VoiceDecoder voiceDecoder;
        // Null until the first Opus packet, and where Opus cannot decode
        private OpusDecoder opusDecoder;

        private void Awake()
        {
            voiceDecoder = new VoiceDecoder(CreateOpusDecoder, ReportOpusFailure);
            voiceServerConnection = VoiceServerConnection.Instance;
            playbackAudioSource = GetComponent<AudioSource>();
            playbackAudioSource.bypassEffects = false;
            playbackAudioSource.bypassListenerEffects = false;
            playbackAudioSource.bypassReverbZones = true;
            playbackAudioSource.playOnAwake = false;
            playbackAudioSource.loop = true;
        }

        private void Start()
        {
            // Debug
            if (Debugging)
            {
                Debug.Log(DEBUG_HEADER + "Output sampling rate: " + AudioSettings.outputSampleRate);
                Debug.Log(DEBUG_HEADER + "Output channel mode: " + AudioSettings.speakerMode);
                Debug.Log(DEBUG_HEADER + "Spatialize: " + playbackAudioSource.spatialize);
            }
            serverSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            resampler = new Resampler(serverSamplingRate, AudioSettings.outputSampleRate);
            fastForwardSamplesThreshold = serverSamplingRate / 1000 * FastForwardLatencyMilliseconds;
            // isInitialized = true;
        }

        private void Update()
        {
            // Debug: Check if data in playback buffer is constant
            if (Debugging && playback)
            {
                timer += Time.deltaTime;
                if (timer > 5f)
                {
                    Debug.Log(DEBUG_HEADER + "Id: " + remoteUserId + " | Samples in playback buffer: " + playbackBuffer.Count);
                    timer = 0f;
                }
            }
        }

        private void OnDestroy()
        {
            // Destroyed while playing, as VoiceManager destroys the receiver of a client it has not
            // heard from: the connection kept delivering to it, and its buffer, which nothing
            // played any more, grew with every packet.
            if (playback && voiceServerConnection != null)
                voiceServerConnection.RemoveVoicePacketListener(remoteUserId, OnSamplesDataReceived);
            playback = false;

            // Here rather than in OnApplicationQuit, so that a receiver destroyed before then frees
            // it too. Null unless an Opus packet has come in and Opus runs here.
            opusDecoder?.Destroy();
        }

        // Use the MonoBehaviour.OnAudioFilterRead callback to playback voice data as fast as possible
        private void OnAudioFilterRead(float[] data, int channels)
        {
            if (playback)
            {
                // Fast forward to latest samples to reduce latency
                if (FastForwardPlayback) FastForwardPlaybackBuffer();
                // Check if the playback buffer has enough data to fill up the data array or otherwise use only the available data
                int dataBufferSize = Mathf.Min(data.Length, playbackBuffer.Count);
                // Get the data from the playback buffer, override the data array with it and remove it from the buffer
                float[] dataBuffer = playbackBuffer.GetRange(0, dataBufferSize).ToArray();
                dataBuffer.CopyTo(data, 0);
                playbackBuffer.RemoveRange(0, dataBufferSize);
                // Clear not already overwritten data
                for (int i = dataBufferSize; i < data.Length; i++)
                {
                    data[i] = 0;
                }
            }
        }

        public void StartPlayback(short id)
        {
            remoteUserId = id;
            voiceServerConnection.AddVoicePacketListener(remoteUserId, OnSamplesDataReceived);
            playbackAudioSource.Play();
            playback = true;
            playbackBuffer = new List<float>();
            Debug.Log(DEBUG_HEADER + "Start voice playback with ID: " + remoteUserId);
        }

        public void StopPlayback()
        {
            Debug.Log(DEBUG_HEADER + "Stop voice playback of ID: " + remoteUserId);
            playback = false;
            playbackAudioSource.Stop();
            voiceServerConnection.RemoveVoicePacketListener(remoteUserId, OnSamplesDataReceived);
        }

        private void OnSamplesDataReceived(VoicePacket voicePacket)
        {
            // Before Start, which reads the sampling rate: StartPlayback right after Instantiate,
            // as VoiceManager calls it, can get a packet delivered in the same frame. The resampler
            // was null then, and the Opus decoder would get the default rate.
            if (resampler == null) return;

            // PCM as it is, Opus decoded, whatever UseOpusCodec says. Null for a packet that
            // cannot be played, such as Opus where it cannot be decoded.
            byte[] shortBytes = voiceDecoder.Decode(voicePacket);
            if (shortBytes == null) return;
            frameSize = voicePacket.FrameSize;

            // Convert bytes to float samples
            float[] samples = SamplingUtility.ConvertShortBytesToFloat(shortBytes);

            // Change volume if necessary
            if (Volume != 1f) samples = SamplingUtility.ChangeVolume(samples, Volume);

            // Convert to output sample rate if necessary
            if (AudioSettings.outputSampleRate != serverSamplingRate) samples = resampler.ResampleStream(samples);

            // Convert mono samples to stereo
            samples = SamplingUtility.ConvertToStereo(samples);

            // Add samples to playback buffer
            playbackBuffer.AddRange(samples); // Sometimes ArgumentOutOfRangeException
        }

        private bool CreateOpusDecoder(out VoiceFrameDecoder decoder, out string error)
        {
            decoder = null;
            if (!OpusDecoder.TryCreate(serverSamplingRate, 1, out opusDecoder, out error))
                return false;
            decoder = DecodeOpus;
            return true;
        }

        private byte[] DecodeOpus(byte[] opus, int frameSamples, out string error)
        {
            byte[] pcm = opusDecoder.TryDecode(opus, frameSamples, out OpusError opusError);
            error = pcm == null ? opusError.ToString() : null;
            return pcm;
        }

        private void ReportOpusFailure(string reason)
        {
            Debug.LogWarning(DEBUG_HEADER + "Opus packets of voice id " + remoteUserId + " that cannot be decoded are dropped (" + reason + "). PCM packets still play. Reported once per receiver.");
        }

        private void FastForwardPlaybackBuffer()
        {
            if (playbackBuffer.Count < fastForwardSamplesThreshold) return;
            // Debug.Log(playbackBuffer.Count + " | " + fastForwardSamplesThreshold);
            playbackBuffer.RemoveRange(0, playbackBuffer.Count - frameSize);
            if (Debugging) Debug.Log(DEBUG_HEADER + "Fast forward latency reached. Empty playback buffer.");
        }
    }
}
