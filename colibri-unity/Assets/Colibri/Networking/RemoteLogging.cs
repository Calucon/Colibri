using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public class RemoteLogging : MonoBehaviour
    {
        private struct LogMsg
        {
            public string Type;
            public string Message;
            public LogMsg(string type, string msg)
            {
                Type = type;
                Message = msg;
            }
        }

        private const float SendIntervalSeconds = 1f;

        private readonly LockFreeQueue<LogMsg> _messages = new LockFreeQueue<LogMsg>();
        private WebServerConnection _server;

        // Written from the send task, which may resume off the main thread.
        private volatile bool _isSending;

        // Set from Unity's threaded log callback, i.e. from arbitrary threads; drained in Update.
        private volatile bool _hasPendingMessages;

        private float _nextSendTime;
        private bool _hasReportedSendFailure;

        void OnEnable()
        {
            _server = WebServerConnection.Instance;
            Application.logMessageReceivedThreaded += OnLogMessage;
        }

        void OnDisable()
        {
            Application.logMessageReceivedThreaded -= OnLogMessage;
        }

        void Update()
        {
            // Batches a second's worth of log lines into one send, and never starts a second
            // send while one is still in flight.
            if (!_hasPendingMessages || _isSending || Time.unscaledTime < _nextSendTime)
                return;

            _hasPendingMessages = false;
            _nextSendTime = Time.unscaledTime + SendIntervalSeconds;
            SendLog();
        }

        private void OnLogMessage(string condition, string stackTrace, LogType type)
        {
            string logType;

            switch (type)
            {
                case LogType.Log:
                    logType = "info";
                    break;

                case LogType.Warning:
                    logType = "warning";
                    break;

                case LogType.Error:
                case LogType.Exception:
                    logType = "error";
                    break;

                case LogType.Assert:
                default:
                    logType = "debug";
                    break;
            }

            var msg = condition;
            if (type == LogType.Error || type == LogType.Exception)
                msg += "\n" + stackTrace;

            _messages.Enqueue(new LogMsg(logType, msg));

            // start sendMessages timer
            _hasPendingMessages = true;
        }

        private async void SendLog()
        {
            var needsRetry = false;
            _isSending = true;
            try
            {
                var msgs = new List<LogMsg>();
                while (_messages.Dequeue(out var logMsg))
                {
                    // skip duplicated messages
                    if (!msgs.Any(l => l.Message == logMsg.Message))
                        msgs.Add(logMsg);
                }

                var hasSent = true;
                foreach (var msg in msgs)
                {
                    if (hasSent)
                        hasSent = await _server.SendCommandAsync("log", msg.Type, msg.Message);

                    if (!hasSent)
                        _messages.Enqueue(msg);
                }

                needsRetry = !hasSent;
            }
            catch (Exception e)
            {
                needsRetry = true;

                // Reported once only: logging from inside the log sender feeds straight back
                // into this queue, so a permanent failure would otherwise spam the console.
                if (!_hasReportedSendFailure)
                {
                    _hasReportedSendFailure = true;
                    Debug.LogWarning($"Colibri: remote logging could not reach the server, retrying quietly - {e.Message}");
                }
            }
            finally
            {
                _isSending = false;
            }

            // Re-armed only after clearing _isSending: Update() ignores anything raised while a
            // send is still in flight.
            if (needsRetry)
                _hasPendingMessages = true;
        }
    }
}
