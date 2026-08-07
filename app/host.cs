using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace UsagePanel;

internal static class Program
{
    internal const string MainWindowTitle = "Usage Panel";
    private const string MutexName = "Local\\SuperZT.UsagePanel";

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            foreach (var process in Process.GetProcessesByName("UsagePanel"))
            {
                if (process.Id != Environment.ProcessId && process.MainWindowHandle != IntPtr.Zero)
                {
                    SetForegroundWindow(process.MainWindowHandle);
                    break;
                }
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private const string PanelUrl = "http://127.0.0.1:8899";
    private readonly string appRoot = AppContext.BaseDirectory;
    private readonly string diagnosticFile;
    private readonly Label failureLabel;
    private readonly WebView2 browser;

    internal MainForm()
    {
        Text = Program.MainWindowTitle;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(720, 480);
        var working = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        ClientSize = new Size(Math.Min(1520, working.Width), Math.Min(940, working.Height));
        BackColor = Color.FromArgb(10, 11, 11);

        var icon = Path.Combine(appRoot, "usage-panel.ico");
        if (File.Exists(icon)) Icon = new Icon(icon);

        diagnosticFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "UsagePanel", "launcher.log");

        failureLabel = new Label
        {
            Dock = DockStyle.Fill,
            ForeColor = Color.White,
            BackColor = BackColor,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 14),
            Text = "Opening Usage Panel..."
        };
        browser = new WebView2
        {
            Dock = DockStyle.Fill,
            Visible = false,
            DefaultBackgroundColor = BackColor,
            CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "UsagePanel", "WebView2")
            }
        };
        Controls.Add(browser);
        Controls.Add(failureLabel);
        Shown += async (_, _) => await OpenPanelAsync();
    }

    private void Record(string status)
    {
        try
        {
            var directory = Path.GetDirectoryName(diagnosticFile)!;
            Directory.CreateDirectory(directory);
            File.AppendAllText(diagnosticFile,
                DateTimeOffset.UtcNow.ToString("O") + " " + status + Environment.NewLine);
            var lines = File.ReadAllLines(diagnosticFile);
            if (lines.Length > 100) File.WriteAllLines(diagnosticFile, lines[^100..]);
        }
        catch { }
    }

    private async Task OpenPanelAsync()
    {
        Record("LAUNCH_STARTED");
        try
        {
            ClearStaleStopMarker();
            await EnrollIfNeededAsync();
            if (!await EnsureServerAsync())
            {
                ShowFailure("Usage Panel could not start. Please reinstall it, then try again.", "SERVER_FAILED");
                return;
            }

            await browser.EnsureCoreWebView2Async();
            browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            browser.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var target)
                    || target.Scheme != Uri.UriSchemeHttp
                    || target.Host != "127.0.0.1"
                    || target.Port != 8899)
                    args.Cancel = true;
            };
            browser.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (!args.IsSuccess)
                    ShowFailure("Usage Panel started, but its window could not load. Close it and try again.", "WEBVIEW_FAILED");
                else
                    Record("WEBVIEW_READY");
            };
            browser.Source = new Uri(PanelUrl);
            failureLabel.Visible = false;
            browser.Visible = true;
            browser.BringToFront();
        }
        catch
        {
            ShowFailure("Usage Panel could not open. Please reinstall it, then try again.", "WEBVIEW_FAILED");
        }
    }

    private void ClearStaleStopMarker()
    {
        try
        {
            var marker = Path.Combine(appRoot, ".usage-panel-stop");
            if (File.Exists(marker))
            {
                File.Delete(marker);
                Record("STALE_STOP_CLEARED");
            }
        }
        catch { }
    }

    private async Task EnrollIfNeededAsync()
    {
        var enrollment = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "usage-panel", "enrollment.json");
        if (File.Exists(enrollment)) return;

        Record("ENROLLMENT_STARTED");
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        var start = new ProcessStartInfo(powershell)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath()
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-File");
        start.ArgumentList.Add(Path.Combine(appRoot, "enroll-panel.ps1"));
        using var process = Process.Start(start);
        if (process is not null) await process.WaitForExitAsync();
        Record("ENROLLMENT_FINISHED");
    }

    private async Task<bool> EnsureServerAsync()
    {
        if (await ServerReadyAsync())
        {
            Record("SERVER_ALREADY_READY");
            return true;
        }

        var stopMarker = Path.Combine(appRoot, ".usage-panel-stop");
        try { if (File.Exists(stopMarker)) File.Delete(stopMarker); } catch { }

        var command = Path.Combine(appRoot, "start-panel.cmd");
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath()
        };
        start.ArgumentList.Add("/d");
        start.ArgumentList.Add("/c");
        start.ArgumentList.Add(command);
        Process.Start(start);
        Record("SERVER_START_REQUESTED");

        for (var attempt = 0; attempt < 60; attempt++)
        {
            await Task.Delay(500);
            if (await ServerReadyAsync())
            {
                Record("SERVER_READY");
                return true;
            }
        }
        return false;
    }

    private static async Task<bool> ServerReadyAsync()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync(PanelUrl + "/api/sync");
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private void ShowFailure(string text, string status)
    {
        Record(status);
        Text = "Usage Panel - Could not open";
        browser.Visible = false;
        failureLabel.Text = text + Environment.NewLine + Environment.NewLine
            + "A private diagnostic status was saved. It contains no codes, credentials, prompts, or account details.";
        failureLabel.Visible = true;
        failureLabel.BringToFront();
    }
}
