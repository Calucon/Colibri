using Cysharp.Threading.Tasks;
using R3;
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

        private readonly LockFreeQueue<LogMsg> _messages = new LockFreeQueue<LogMsg>();
        private readonly Subject<int> _msgSubject = new Subject<int>();
        private WebServerConnection _server;

        // Written from the send task, which may resume off the main thread.
        private volatile bool _isSending;

        void OnEnable()
        {
            _server = WebServerConnection.Instance;
            Application.logMessageReceivedThreaded += OnLogMessage;

            _msgSubject
                .Where(_ => !_isSending)
                .ThrottleLast(TimeSpan.FromSeconds(1))
                .Subscribe(_ => SendLog().Forget())
                .AddTo(this);
        }

        void OnDisable()
        {
            Application.logMessageReceivedThreaded -= OnLogMessage;
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
            _msgSubject.OnNext(0);
        }

        private async UniTaskVoid SendLog()
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
            finally
            {
                _isSending = false;
            }

            // Re-armed only after clearing _isSending: the Where() gate in front of the
            // throttle drops anything published while a send is still in flight.
            if (needsRetry)
                _msgSubject.OnNext(0);
        }
    }
}
