using System.Linq;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEditor;
using Setting = HCIKonstanz.Colibri.Setup.AndroidSettingsCheck.Setting;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The two Player settings that break a Meta Quest build without a word: no INTERNET
    /// permission means no socket, and plain HTTP to a remote server means no Store. Only the
    /// detection is tested here - the fixes write the project's real Player settings.
    /// </summary>
    public class AndroidSettingsCheckTests
    {
        private const string RemoteServer = "192.168.1.20";

        private static Setting[] Issues(BuildTarget target = BuildTarget.Android, string server = RemoteServer, bool ssl = false,
            InsecureHttpOption http = InsecureHttpOption.NotAllowed, bool development = false, bool internet = false)
            => AndroidSettingsCheck.FindIssues(target, server, ssl, http, development, internet).Select(i => i.Setting).ToArray();

        [Test]
        public void AnAndroidBuildWithBothSettingsWrongReportsBoth()
        {
            Assert.That(Issues(), Is.EquivalentTo(new[] { Setting.InternetAccess, Setting.AllowDownloadsOverHttp }));
        }

        [Test]
        public void AnAndroidBuildWithBothSettingsRightReportsNothing()
        {
            Assert.That(Issues(http: InsecureHttpOption.AlwaysAllowed, internet: true), Is.Empty);
        }

        [Test]
        public void OtherBuildTargetsAreLeftAlone()
        {
            Assert.That(Issues(target: BuildTarget.StandaloneWindows64), Is.Empty);
        }

        [Test]
        public void InternetAccessAutoIsReported()
        {
            Assert.That(Issues(http: InsecureHttpOption.AlwaysAllowed, internet: false), Is.EqualTo(new[] { Setting.InternetAccess }));
        }

        [Test]
        public void PlainHttpIsNotAProblemWhenTheServerUsesSsl()
        {
            Assert.That(Issues(ssl: true, internet: true), Is.Empty);
        }

        [TestCase("localhost")]
        [TestCase("LOCALHOST")]
        [TestCase("127.0.0.1")]
        [TestCase("::1")]
        public void PlainHttpToLoopbackIsNotAProblem(string server)
        {
            // Unity lets plain HTTP through to localhost whatever the setting says.
            Assert.That(Issues(server: server, internet: true), Is.Empty);
        }

        [Test]
        public void HttpAllowedInDevelopmentBuildsCoversDevelopmentBuildsOnly()
        {
            Assert.That(Issues(http: InsecureHttpOption.DevelopmentOnly, development: true, internet: true), Is.Empty);
            Assert.That(Issues(http: InsecureHttpOption.DevelopmentOnly, development: false, internet: true),
                Is.EqualTo(new[] { Setting.AllowDownloadsOverHttp }));
        }

        [Test]
        public void EveryIssueOffersAFix()
        {
            foreach (var issue in AndroidSettingsCheck.FindIssues(BuildTarget.Android, RemoteServer, false, InsecureHttpOption.NotAllowed, false, false))
            {
                Assert.That(issue.Fix, Is.Not.Null, issue.Message);
                Assert.That(issue.FixLabel, Is.Not.Empty, issue.Message);
            }
        }
    }
}
