using System;
using System.Collections;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    /// <summary>
    /// Puts Colibri under load and says what happened.
    ///
    /// Run it in two editors side by side - that is the configuration it exists for. One drives a
    /// few hundred synchronized objects, the other watches what arrives, and both show the same
    /// panel. Turn the object count up until the numbers stop being acceptable; the point at which
    /// that happens is the answer you came for.
    /// </summary>
    /// <remarks>
    /// There are two separate instruments here, and keeping them apart is what makes the readings
    /// mean anything:
    ///
    /// - <b>Load</b> is <see cref="StressModel"/> objects being moved. Realistic, because it is
    ///   how a real scene generates traffic - but state sync coalesces per frame, so a missing
    ///   value is not a missing message and this cannot measure loss.
    /// - <b>Latency and loss</b> ride on a separate low-rate probe channel where every message is
    ///   meant to arrive exactly once. It is a round trip, so no clock is shared between the two
    ///   ends and the figure stays honest across machines. Kept at a low rate deliberately: it is
    ///   measuring the delay under the load, not adding to it.
    /// </remarks>
    public class NetworkStressHarness : MonoBehaviour
    {
        /// <summary>
        /// Its own channel, not one of the sample channels. Anything else on "myChannel" would be
        /// counted as a lost probe the moment it did not echo.
        /// </summary>
        private const string ProbeChannel = "colibri-stress-probe";

        /// <summary>A probe unanswered for this long is counted as lost rather than slow.</summary>
        private const float ProbeTimeoutSeconds = 2f;

        private const int RttSampleCapacity = 2000;

        /// <summary>
        /// Objects created per frame while catching up to the requested count. Creating several
        /// hundred in one frame locks the editor for long enough to look like a crash, and each
        /// one asks the server for its initial state as it wakes.
        /// </summary>
        private const int SpawnBudgetPerFrame = 25;

        [Header("Load")]
        [Tooltip("Synchronized objects in the scene. Press Apply after changing.")]
        [Range(0, 500)] public int ObjectCount = 100;

        [Tooltip("How many of them move each frame. One moving object is one message per frame.")]
        [Range(0f, 1f)] public float MovingFraction = 1f;

        [Tooltip("Ballast added to every object's payload, in bytes.")]
        [Range(0, 4096)] public int PaddingBytes;

        [Header("Measurement")]
        [Tooltip("Round-trip probes per second. 0 turns latency measurement off.")]
        [Range(0, 200)] public int ProbeRateHz = 20;

        [Tooltip("Draw the panel. The numbers keep being collected either way.")]
        public bool ShowPanel = true;

        [Tooltip("Also write one summary line this often. 0 turns it off. There is no Game view in "
            + "a batchmode run or a headless build, and a stress tool that can only be read by "
            + "looking at it cannot be automated.")]
        [Range(0f, 60f)] public float LogSummaryEverySeconds;

        private readonly List<StressModel> _objects = new List<StressModel>();
        private StressModelManager _manager;
        private WebServerConnection _connection;

        // Identifies this client's probes so an echo can be told from someone else's ping, and so
        // two harnesses measuring at once do not read each other's round trips as their own.
        private string _originId;

        private string _padding = "";
        private int _paddingBytesApplied = -1;

        private int _probeSeq;
        private readonly Dictionary<int, float> _outstandingProbes = new Dictionary<int, float>();
        private readonly List<int> _expired = new List<int>();
        private float _probeCredit;

        private readonly float[] _rtt = new float[RttSampleCapacity];
        private int _rttWrite;
        private int _rttCount;
        private float _rttWorst;

        private long _probesSent;
        private long _probesEchoed;
        private long _probesLost;
        private long _probesOutOfOrder;
        private int _highestEchoSeen;

        private long _modelsSent;
        private long _modelsSentAtSample;
        private long _modelsReceivedAtSample;
        private long _probesEchoedAtSample;
        private float _nextRateSample;
        private float _outPerSecond;
        private float _inPerSecond;
        private float _echoPerSecond;

        private float _smoothedFrameSeconds;
        private float _worstFrameSeconds;

        private ConnectionStatus _lastStatus = ConnectionStatus.Disconnected;
        private bool _hasEverConnected;
        private int _reconnects;
        private float _disconnectedAt;
        private float _lastReconnectSeconds;

        // Percentiles are only worth recomputing as fast as they are read.
        private float _nextPercentileRefresh;
        private float _nextSummaryLog;
        private float _p50, _p95, _p99;
        private float[] _sortBuffer = new float[RttSampleCapacity];

        private GUIStyle _panelStyle;
        private GUIStyle _headingStyle;
        private GUIStyle _warningStyle;


        private void Awake()
        {
            // Without this an unfocused editor suspends its player loop, and the client that is
            // supposed to be receiving the flood quietly stops running at all.
            Application.runInBackground = true;

            _originId = Guid.NewGuid().ToString("N").Substring(0, 8);
            // "Any" rather than "First": there should be exactly one of each of these in the
            // scene, so instance-ID ordering buys nothing and the ordered variant is deprecated.
            _manager = FindAnyObjectByType<StressModelManager>();

            if (_manager == null)
                Debug.LogWarning("No StressModelManager in the scene - objects created by the other client will never appear here.");

            ResetStats();
        }

        private void OnEnable() => Sync.Receive<JToken>(ProbeChannel, OnProbe);

        // Destroying this object would drop the listener on its own; disabling it would not, and a
        // disabled harness still answering probes would make the other client's latency look fine.
        private void OnDisable() => Sync.Unregister<JToken>(ProbeChannel, OnProbe);

        private void OnDestroy() => ClearObjects();


        /*
         *  Load
         */

        private void Update()
        {
            TrackFrameTime();
            TrackConnection();

            RefreshPadding();
            AdjustObjectCount();
            DriveObjects();

            SendProbes();
            ExpireProbes();

            SampleRates();
            LogSummary();
        }

        private void LogSummary()
        {
            if (LogSummaryEverySeconds <= 0f)
                return;

            var now = Time.realtimeSinceStartup;
            if (now < _nextSummaryLog)
                return;

            _nextSummaryLog = now + LogSummaryEverySeconds;
            RefreshPercentiles(force: true);

            Debug.Log(
                $"STRESS objects={_objects.Count} out={_outPerSecond:0}/s in={_inPerSecond:0}/s "
                + $"frame={_smoothedFrameSeconds * 1000f:0.0}ms worstFrame={_worstFrameSeconds * 1000f:0}ms "
                + $"rtt_p50={_p50:0.0}ms rtt_p95={_p95:0.0}ms rtt_p99={_p99:0.0}ms rtt_max={_rttWorst:0.0}ms "
                + $"probes={_probesEchoed}/{_probesSent} lost={_probesLost} outOfOrder={_probesOutOfOrder} "
                + $"coalesced={StressModel.Coalesced} reconnects={_reconnects}");
        }

        private void RefreshPadding()
        {
            if (PaddingBytes == _paddingBytesApplied)
                return;

            _paddingBytesApplied = PaddingBytes;
            _padding = PaddingBytes <= 0 ? "" : new string('x', PaddingBytes);
        }

        private void AdjustObjectCount()
        {
            // Destroying is cheap; creating is not, and a few hundred at once locks up the editor.
            while (_objects.Count > ObjectCount)
            {
                var last = _objects.Count - 1;
                if (_objects[last] != null)
                    Destroy(_objects[last].gameObject);
                _objects.RemoveAt(last);
            }

            var budget = SpawnBudgetPerFrame;
            while (_objects.Count < ObjectCount && budget-- > 0)
                _objects.Add(CreateObject(_objects.Count));
        }

        private StressModel CreateObject(int index)
        {
            var template = _manager != null ? _manager.Template : null;

            // Instantiating the manager's template keeps the two clients rendering the same thing.
            // Falling back to a bare primitive means the scene still works if the template is
            // unassigned - with a warning, since that is a wiring mistake rather than a mode.
            GameObject go;
            if (template != null)
            {
                go = Instantiate(template.gameObject);
            }
            else
            {
                go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                if (index == 0)
                    Debug.LogWarning("StressModelManager has no Template assigned; spawning bare cubes instead.");
            }

            go.name = $"StressObject{index}";
            go.transform.position = GridPosition(index);

            var model = go.GetComponent<StressModel>();
            if (model == null)
                model = go.AddComponent<StressModel>();

            return model;
        }

        private static Vector3 GridPosition(int index)
        {
            const int perRow = 25;
            return new Vector3(index % perRow - perRow / 2f, index / perRow - 6f, 0f);
        }

        private void DriveObjects()
        {
            var moving = Mathf.RoundToInt(_objects.Count * MovingFraction);
            var t = Time.realtimeSinceStartup;

            for (var i = 0; i < moving; i++)
            {
                var model = _objects[i];
                if (model == null)
                    continue;

                // Always a different value from last frame, so every driven object really does
                // produce a message and the outbound count below is a count rather than a guess.
                var basePosition = GridPosition(i);
                basePosition.z = Mathf.Sin(t * 2f + i * 0.3f);

                model.Drive(basePosition, _padding);
                _modelsSent++;
            }
        }


        /*
         *  Probes - the only thing here that can honestly report a dropped message
         */

        private void SendProbes()
        {
            if (ProbeRateHz <= 0)
                return;

            // Credit rather than a timer, so a client running at 10 fps still sends 20 probes a
            // second rather than silently measuring at its frame rate.
            _probeCredit += ProbeRateHz * Time.unscaledDeltaTime;

            while (_probeCredit >= 1f)
            {
                _probeCredit -= 1f;

                _probeSeq++;
                _outstandingProbes[_probeSeq] = Time.realtimeSinceStartup;
                _probesSent++;

                Sync.Send(ProbeChannel, new JObject
                {
                    { "o", _originId },
                    { "s", _probeSeq },
                    { "e", false }
                });
            }
        }

        private void OnProbe(JToken payload)
        {
            if (!(payload is JObject message))
                return;

            var origin = message["o"]?.Value<string>();
            var seq = message["s"]?.Value<int>() ?? 0;
            var isEcho = message["e"]?.Value<bool>() ?? false;

            if (string.IsNullOrEmpty(origin))
                return;

            if (!isEcho)
            {
                // Answering is unconditional: an instance is useful as the far end of someone
                // else's measurement without having to be put into a mode first.
                Sync.Send(ProbeChannel, new JObject
                {
                    { "o", origin },
                    { "s", seq },
                    { "e", true }
                });
                return;
            }

            if (origin != _originId)
                return;

            if (!_outstandingProbes.TryGetValue(seq, out var sentAt))
                return; // Already timed out and counted as lost, or not ours to begin with.

            _outstandingProbes.Remove(seq);
            _probesEchoed++;

            if (seq < _highestEchoSeen)
                _probesOutOfOrder++;
            else
                _highestEchoSeen = seq;

            RecordRtt((Time.realtimeSinceStartup - sentAt) * 1000f);
        }

        private void RecordRtt(float millis)
        {
            _rtt[_rttWrite] = millis;
            _rttWrite = (_rttWrite + 1) % RttSampleCapacity;
            if (_rttCount < RttSampleCapacity)
                _rttCount++;

            if (millis > _rttWorst)
                _rttWorst = millis;
        }

        private void ExpireProbes()
        {
            if (_outstandingProbes.Count == 0)
                return;

            var deadline = Time.realtimeSinceStartup - ProbeTimeoutSeconds;

            _expired.Clear();
            foreach (var pair in _outstandingProbes)
            {
                if (pair.Value < deadline)
                    _expired.Add(pair.Key);
            }

            for (var i = 0; i < _expired.Count; i++)
            {
                _outstandingProbes.Remove(_expired[i]);
                _probesLost++;
            }
        }


        /*
         *  Measurement
         */

        private void TrackFrameTime()
        {
            var delta = Time.unscaledDeltaTime;

            _smoothedFrameSeconds = _smoothedFrameSeconds <= 0f
                ? delta
                : Mathf.Lerp(_smoothedFrameSeconds, delta, 0.1f);

            if (delta > _worstFrameSeconds)
                _worstFrameSeconds = delta;
        }

        private void TrackConnection()
        {
            if (_connection == null)
                _connection = FindAnyObjectByType<WebServerConnection>();

            if (_connection == null)
                return;

            var status = _connection.Status;
            if (status == _lastStatus)
                return;

            if (status == ConnectionStatus.Connected)
            {
                if (_hasEverConnected)
                {
                    _reconnects++;
                    _lastReconnectSeconds = Time.realtimeSinceStartup - _disconnectedAt;
                }
                _hasEverConnected = true;
            }
            else if (_lastStatus == ConnectionStatus.Connected)
            {
                _disconnectedAt = Time.realtimeSinceStartup;
            }

            _lastStatus = status;
        }

        private void SampleRates()
        {
            var now = Time.realtimeSinceStartup;
            if (now < _nextRateSample)
                return;

            // First call after a reset establishes the baseline rather than reporting a rate over
            // an unknown interval.
            if (_nextRateSample > 0f)
            {
                _outPerSecond = _modelsSent - _modelsSentAtSample;
                _inPerSecond = StressModel.Received - _modelsReceivedAtSample;
                _echoPerSecond = _probesEchoed - _probesEchoedAtSample;
            }

            _modelsSentAtSample = _modelsSent;
            _modelsReceivedAtSample = StressModel.Received;
            _probesEchoedAtSample = _probesEchoed;
            _nextRateSample = now + 1f;
        }

        private void RefreshPercentiles(bool force = false)
        {
            if (!force && Time.realtimeSinceStartup < _nextPercentileRefresh)
                return;

            _nextPercentileRefresh = Time.realtimeSinceStartup + 0.1f;

            if (_rttCount == 0)
            {
                _p50 = _p95 = _p99 = 0f;
                return;
            }

            Array.Copy(_rtt, _sortBuffer, _rttCount);
            Array.Sort(_sortBuffer, 0, _rttCount);

            _p50 = Percentile(0.50f);
            _p95 = Percentile(0.95f);
            _p99 = Percentile(0.99f);
        }

        private float Percentile(float fraction)
        {
            var index = Mathf.Clamp(Mathf.CeilToInt(fraction * _rttCount) - 1, 0, _rttCount - 1);
            return _sortBuffer[index];
        }


        /*
         *  Controls
         */

        private void ResetStats()
        {
            StressModel.ResetCounters();

            _modelsSent = 0;
            _modelsSentAtSample = 0;
            _modelsReceivedAtSample = 0;
            _probesEchoedAtSample = 0;
            _nextRateSample = 0f;
            _outPerSecond = _inPerSecond = _echoPerSecond = 0f;

            _probesSent = _probesEchoed = _probesLost = _probesOutOfOrder = 0;
            _highestEchoSeen = 0;
            _outstandingProbes.Clear();

            _rttWrite = _rttCount = 0;
            _rttWorst = 0f;
            _p50 = _p95 = _p99 = 0f;

            _worstFrameSeconds = 0f;
            _reconnects = 0;
            _lastReconnectSeconds = 0f;
        }

        private void ClearObjects()
        {
            foreach (var model in _objects)
            {
                if (model != null)
                    Destroy(model.gameObject);
            }
            _objects.Clear();
        }

        /// <summary>
        /// Drops the socket without touching the library: the connection's own OnDisable cancels
        /// its lifetime and closes the socket, and OnEnable starts a fresh loop. Stopping the
        /// server instead exercises the same path with a real outage and the reconnect backoff.
        /// </summary>
        private IEnumerator DropConnection()
        {
            if (_connection == null)
                yield break;

            _connection.enabled = false;
            yield return null;
            _connection.enabled = true;
        }


        /*
         *  Panel
         */

        private void OnGUI()
        {
            if (!ShowPanel)
                return;

            EnsureStyles();
            RefreshPercentiles();

            GUILayout.BeginArea(new Rect(10f, 10f, 430f, Screen.height - 20f), _panelStyle);
            GUILayout.Label("Colibri network stress", _headingStyle);

            DrawConnectionSection();
            DrawLoadSection();
            DrawLatencySection();
            DrawControls();

            GUILayout.EndArea();
        }

        private void DrawConnectionSection()
        {
            GUILayout.Space(6f);
            GUILayout.Label("Connection", _headingStyle);

            if (_connection == null)
            {
                GUILayout.Label("No connection in the scene yet.");
                return;
            }

            Row("Status", _connection.Status.ToString());
            Row("Server", $"{_connection.ServerAddress}:{_connection.TcpPort}");
            Row("Heartbeat", $"{_connection.MillisSinceLastHeartbeat()} ms ago");
            Row("Delivery", $"{_connection.DeliveryFramesPerSecond:0} fps");
            Row("Frame", $"{_smoothedFrameSeconds * 1000f:0.0} ms   (worst {_worstFrameSeconds * 1000f:0} ms)");

            if (_reconnects > 0)
                Row("Reconnects", $"{_reconnects}   (last took {_lastReconnectSeconds:0.0} s)");
        }

        private void DrawLoadSection()
        {
            GUILayout.Space(6f);
            GUILayout.Label("Load", _headingStyle);

            var spawning = _objects.Count != ObjectCount;
            Row("Objects", spawning ? $"{_objects.Count} of {ObjectCount}..." : _objects.Count.ToString());
            Row("Out", $"{_outPerSecond:0} msg/s");
            Row("In", $"{_inPerSecond:0} msg/s");

            // Named for what it is. A missing value here is last-write-wins doing its job, not a
            // message the network dropped - the probe channel below is what measures that.
            Row("Coalesced", $"{StressModel.Coalesced}   (superseded before sending, not lost)");

            if (_objects.Count == 0 && ObjectCount == 0)
                GUILayout.Label("Idle - receiving only. Drive the load from the other client.");
        }

        private void DrawLatencySection()
        {
            GUILayout.Space(6f);
            GUILayout.Label("Round trip", _headingStyle);

            if (ProbeRateHz <= 0)
            {
                GUILayout.Label("Probing is off.");
                return;
            }

            if (_probesEchoed == 0)
            {
                GUILayout.Label(_probesSent == 0
                    ? "No probes sent yet."
                    : "Nothing has come back yet - is a second client running this scene?");
                return;
            }

            Row("p50 / p95 / p99", $"{_p50:0.0} / {_p95:0.0} / {_p99:0.0} ms");
            Row("Worst", $"{_rttWorst:0.0} ms");
            Row("Echoed", $"{_probesEchoed} of {_probesSent}   ({_echoPerSecond:0}/s)");

            if (_probesLost > 0)
            {
                var percent = 100f * _probesLost / Mathf.Max(1L, _probesSent);
                GUILayout.Label(
                    $"Lost {_probesLost} probe(s), {percent:0.0}% - these were real dropped messages. "
                    + "The server discards writes to a client whose socket is more than 1 MB behind, "
                    + "and says so in its own log.",
                    _warningStyle);
            }

            if (_probesOutOfOrder > 0)
                Row("Out of order", _probesOutOfOrder.ToString());
        }

        private void DrawControls()
        {
            GUILayout.Space(8f);
            GUILayout.Label("Controls", _headingStyle);

            GUILayout.Label($"Objects: {ObjectCount}");
            ObjectCount = Mathf.RoundToInt(GUILayout.HorizontalSlider(ObjectCount, 0f, 500f));

            GUILayout.Label($"Moving: {MovingFraction * 100f:0}%");
            MovingFraction = GUILayout.HorizontalSlider(MovingFraction, 0f, 1f);

            GUILayout.Label($"Padding: {PaddingBytes} bytes");
            PaddingBytes = Mathf.RoundToInt(GUILayout.HorizontalSlider(PaddingBytes, 0f, 4096f));

            GUILayout.Label($"Probe rate: {ProbeRateHz} Hz");
            ProbeRateHz = Mathf.RoundToInt(GUILayout.HorizontalSlider(ProbeRateHz, 0f, 200f));

            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();

            if (GUILayout.Button("Reset stats"))
                ResetStats();

            if (GUILayout.Button("Drop connection"))
                StartCoroutine(DropConnection());

            GUILayout.EndHorizontal();
        }

        private static void Row(string label, string value)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label(label, GUILayout.Width(120f));
            GUILayout.Label(value);
            GUILayout.EndHorizontal();
        }

        private void EnsureStyles()
        {
            if (_panelStyle != null)
                return;

            _panelStyle = new GUIStyle(GUI.skin.box) { padding = new RectOffset(10, 10, 10, 10) };
            _headingStyle = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold };
            _warningStyle = new GUIStyle(GUI.skin.label) { wordWrap = true };
            _warningStyle.normal.textColor = new Color(1f, 0.7f, 0.3f);
        }
    }
}
