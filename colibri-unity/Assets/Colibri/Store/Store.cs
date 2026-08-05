using UnityEngine;
using UnityEngine.Networking;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json;

namespace HCIKonstanz.Colibri.Store
{
    public static class Store
    {
        /// <summary>
        /// UnityWebRequest defaults to no timeout at all, so a wrong or unreachable server
        /// address left Get/Put/Delete outstanding forever - no result, no error, nothing in
        /// the console. An unconfigured project reaches the public default server, where this
        /// was observed to still be waiting after a minute. Ten seconds is long enough for a
        /// slow link and short enough that the failure is reported while the student is still
        /// looking at it.
        /// </summary>
        private const int TimeoutSeconds = 10;

        /// <summary>
        /// Awaits a UnityWebRequest without pulling in a third-party awaiter.
        /// </summary>
        /// <remarks>
        /// Deliberately *not* created with TaskCreationOptions.RunContinuationsAsynchronously:
        /// UnityWebRequestAsyncOperation raises `completed` on the main thread, and completing the
        /// task inline is what keeps the caller's code after `await` on the main thread too. Unlike
        /// the UniTask awaiter this never throws - the caller checks `request.result` instead.
        /// </remarks>
        private static Task SendAsync(UnityWebRequest request)
        {
            var tcs = new TaskCompletionSource<bool>();
            request.SendWebRequest().completed += _ => tcs.TrySetResult(true);
            return tcs.Task;
        }

        private static void LogFailure(string action, string objectName, UnityWebRequest request, string url)
        {
            Debug.LogError($"Colibri: could not {action} \"{objectName}\" at {url} - {request.error} (HTTP {request.responseCode}). Check the server address and app name in Window -> Colibri Configuration.");
        }

        public static async Task<T> Get<T>(string objectName)
        {
            var url = ColibriConfig.GetWebUrl($"api/store/{ColibriConfig.Load().AppName}/{objectName}");
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                request.method = UnityWebRequest.kHttpVerbGET;
                request.timeout = TimeoutSeconds;
                request.SetRequestHeader("Accept", "application/json");
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && request.responseCode == 200)
                {
                    // Newtonsoft rather than JsonUtility: JsonUtility cannot round-trip
                    // dictionaries, properties, or top-level arrays, so Get/Put silently
                    // disagreed with everything Sync can carry.
                    return JsonConvert.DeserializeObject<T>(request.downloadHandler.text);
                }

                LogFailure("load", objectName, request, url);
            }
            return default;
        }

        public static async Task<bool> Put(string objectName, object putObject)
        {
            string jsonData = JsonConvert.SerializeObject(putObject);
            var url = ColibriConfig.GetWebUrl($"api/store/{ColibriConfig.Load().AppName}/{objectName}");
            using (UnityWebRequest request = UnityWebRequest.Put(url, jsonData))
            {
                request.method = UnityWebRequest.kHttpVerbPUT;
                request.timeout = TimeoutSeconds;
                request.SetRequestHeader("Content-Type", "application/json");
                request.SetRequestHeader("Accept", "application/json");
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && (request.responseCode == 200 || request.responseCode == 201))
                    return true;

                LogFailure("save", objectName, request, url);
            }
            return false;
        }

        public static async Task<bool> Delete(string objectName)
        {
            var url = ColibriConfig.GetWebUrl($"api/store/{ColibriConfig.Load().AppName}/{objectName}");
            using (UnityWebRequest request = UnityWebRequest.Delete(url))
            {
                request.method = UnityWebRequest.kHttpVerbDELETE;
                request.timeout = TimeoutSeconds;
                request.SetRequestHeader("Content-Type", "application/json");
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && request.responseCode == 200)
                    return true;

                LogFailure("delete", objectName, request, url);
            }
            return false;
        }
    }
}
