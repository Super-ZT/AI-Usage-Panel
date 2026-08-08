using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using UsagePanel.Core;

namespace UsagePanel;

internal static class Program
{
    internal const string MainWindowTitle = "Usage Panel";
    private const string MutexName = "Local\\SuperZT.UsagePanel";

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            FocusRunningInstance();
            return;
        }

        // An unhandled exception is what "nothing happens" looked like in
        // v1.0.2, so it must end on a message the customer can read. Only the
        // fixed sentence and a status word are shown or stored; the exception
        // itself is never surfaced, because its text can carry a path or a
        // credential.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, _) => ReportUnexpectedError();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => ReportUnexpectedError();

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }

    private static void ReportUnexpectedError()
    {
        try
        {
            new Diagnostics(MainForm.DiagnosticPath()).Record(StatusCodes.UnexpectedError);
            MessageBox.Show(
                "Usage Panel hit an unexpected problem and has to close.\n\n"
                + "Open it again. If it keeps happening, reinstall Usage Panel.\n\n"
                + "A private diagnostic status was saved. It contains no codes, credentials, "
                + "prompts, or account details.",
                MainWindowTitle,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch
        {
            // Reporting the failure must not itself become a new failure.
        }
    }

    /// <summary>
    /// Brings the existing window forward. A minimised window must be restored
    /// first; focusing it alone leaves the customer looking at an empty desktop
    /// and concluding, correctly, that nothing happened.
    /// </summary>
    private static void FocusRunningInstance()
    {
        var diagnostics = new Diagnostics(MainForm.DiagnosticPath());
        try
        {
            foreach (var process in Process.GetProcessesByName("UsagePanel"))
            {
                if (process.Id == Environment.ProcessId) continue;
                var window = process.MainWindowHandle;
                if (window == IntPtr.Zero) continue;

                if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
                SetForegroundWindow(window);
                diagnostics.Record(StatusCodes.SecondInstanceFocused);
                return;
            }
        }
        catch
        {
            // Focusing is a courtesy; never let it crash the second launch.
        }
    }
}

internal sealed class MainForm : Form
{
    private const string PanelUrl = "http://127.0.0.1:8899";
    private const int PanelPort = 8899;

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    private readonly string appRoot = AppContext.BaseDirectory;
    private readonly Diagnostics diagnostics;
    private readonly PanelProbe probe = new("127.0.0.1", PanelPort);
    private readonly Label failureLabel;
    private readonly Label noticeLabel;
    private readonly WebView2 browser;

    private Process? serverLauncher;
    private bool shutdownRecorded;

    internal static string DiagnosticPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "UsagePanel", "launcher.log");

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

        diagnostics = new Diagnostics(DiagnosticPath());

        failureLabel = new Label
        {
            Dock = DockStyle.Fill,
            ForeColor = Color.White,
            BackColor = BackColor,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 14),
            Text = "Opening Usage Panel..."
        };
        noticeLabel = new Label
        {
            Dock = DockStyle.Top,
            AutoSize = false,
            Height = 52,
            Visible = false,
            ForeColor = Color.White,
            BackColor = Color.FromArgb(72, 52, 12),
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(16, 0, 16, 0),
            Font = new Font("Segoe UI", 10)
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
        Controls.Add(noticeLabel);

        Shown += async (_, _) =>
        {
            // The window is on screen before any slow work begins; record the
            // measured state rather than the intention.
            diagnostics.Record(IsWindowVisible(Handle) ? StatusCodes.WindowVisible : StatusCodes.DashboardHidden);
            await OpenPanelAsync();
        };
        FormClosing += (_, _) => Shutdown();
    }

    private void Record(string status) => diagnostics.Record(status);

    private async Task OpenPanelAsync()
    {
        Record(StatusCodes.LaunchStarted);
        try
        {
            ClearStaleStopMarker();

            var payload = InstallPayload.Inspect(appRoot, NodeOnPath());
            var port = await probe.ClassifyAsync();
            var preflight = StartupPlan.PreFlight(payload, port, WebView2Available());
            if (preflight is not null)
            {
                ShowFailure(preflight);
                return;
            }

            await EnrollIfNeededAsync();

            if (port == PortState.OwnedByPanel) Record(StatusCodes.ServerAlreadyReady);
            else if (StartupPlan.AfterServerStart(await StartServerAsync()) is { } serverFault)
            {
                ShowFailure(serverFault);
                return;
            }

            await ShowDashboardAsync();
        }
        catch
        {
            // Any unforeseen failure still ends on a visible screen.
            ShowFailure(StartupPlan.NavigationFailed());
        }
    }

    private async Task ShowDashboardAsync()
    {
        await browser.EnsureCoreWebView2Async();
        browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
        browser.CoreWebView2.NavigationStarting += (_, args) =>
        {
            if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var target)
                || target.Scheme != Uri.UriSchemeHttp
                || target.Host != "127.0.0.1"
                || target.Port != PanelPort)
                args.Cancel = true;
        };
        browser.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            if (!args.IsSuccess)
            {
                ShowFailure(StartupPlan.NavigationFailed());
                return;
            }

            RevealDashboard();
            // Measured, not asserted: if the reveal above is ever removed or
            // overdrawn, this writes DASHBOARD_HIDDEN and the Windows smoke
            // test fails. A log line that cannot disagree with the screen is
            // how v1.0.2 passed while showing nothing.
            Record(DashboardVisibility.StatusFor(ReadSurface()));
        };
        browser.Source = new Uri(PanelUrl);
    }

    private void RevealDashboard()
    {
        failureLabel.Visible = false;
        browser.Visible = true;
        browser.BringToFront();
    }

    /// <summary>Reads the real Win32 state of the window and the dashboard control.</summary>
    private WindowSurface ReadSurface()
    {
        try
        {
            return new WindowSurface(
                FormVisible: Visible,
                FormMinimized: WindowState == FormWindowState.Minimized,
                FormHandleVisible: IsWindowVisible(Handle),
                DashboardControlVisible: browser.Visible,
                FailureMessageVisible: failureLabel.Visible,
                DashboardWidth: browser.Width,
                DashboardHeight: browser.Height,
                DashboardHandleVisible: IsWindowVisible(browser.Handle));
        }
        catch
        {
            return default;
        }
    }

    /// <summary>
    /// The embedded browser runtime is a separate Windows component. Detecting
    /// its absence lets us give the one remedy that works, instead of telling
    /// the customer to reinstall Usage Panel, which cannot install it.
    /// </summary>
    private static bool WebView2Available()
    {
        // CI smoke-only force: proves the in-window WEBVIEW2_MISSING path without
        // uninstalling the runner runtime. Not used by customer shortcuts.
        if (string.Equals(
                Environment.GetEnvironmentVariable("USAGE_PANEL_SMOKE_FORCE_WEBVIEW2_MISSING"),
                "1",
                StringComparison.Ordinal))
        {
            return false;
        }

        try
        {
            return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch
        {
            return false;
        }
    }

    private static bool NodeOnPath()
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path)) return false;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                if (File.Exists(Path.Combine(directory.Trim('"'), "node.exe"))) return true;
            }
            catch
            {
                // An unreadable PATH entry is simply not a match.
            }
        }
        return false;
    }

    private string StopMarkerPath() => Path.Combine(appRoot, ".usage-panel-stop");

    private void ClearStaleStopMarker()
    {
        try
        {
            var marker = StopMarkerPath();
            if (File.Exists(marker))
            {
                File.Delete(marker);
                Record(StatusCodes.StaleStopCleared);
            }
        }
        catch
        {
            // A marker we cannot delete surfaces later as SERVER_FAILED.
        }
    }

    private async Task EnrollIfNeededAsync()
    {
        var enrollment = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "usage-panel", "enrollment.json");
        if (File.Exists(enrollment)) return;

        if (!await new NetworkProbe().CanReachAsync())
        {
            ShowNotice(StartupPlan.NetworkUnavailable());
            return;
        }

        Record(StatusCodes.EnrollmentStarted);
        var script = Path.Combine(appRoot, "enroll-panel.ps1");
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(script) || !File.Exists(powershell))
        {
            ShowNotice(StartupPlan.EnrollmentFailed());
            return;
        }

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
        start.ArgumentList.Add(script);

        try
        {
            using var process = Process.Start(start);
            if (process is null)
            {
                ShowNotice(StartupPlan.EnrollmentFailed());
                return;
            }
            await process.WaitForExitAsync();
            Record(StatusCodes.EnrollmentFinished);
        }
        catch
        {
            // Linking is optional; the local dashboard must still open.
            ShowNotice(StartupPlan.EnrollmentFailed());
        }
    }

    private async Task<bool> StartServerAsync()
    {
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

        try
        {
            serverLauncher = Process.Start(start);
        }
        catch
        {
            return false;
        }
        Record(StatusCodes.ServerStartRequested);

        var deadline = DateTimeOffset.UtcNow.AddSeconds(30);
        while (DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(500);
            if (await probe.AnswersAsPanelAsync())
            {
                Record(StatusCodes.ServerReady);
                return true;
            }
            // A launcher that has already exited will never become ready.
            if (serverLauncher is { HasExited: true }) return false;
        }
        return false;
    }

    /// <summary>
    /// Closing the window ends the whole product: v1.0.3 has no tray icon and
    /// no hidden background mode, so nothing of ours may outlive the window.
    /// Only executables inside the install directory are terminated.
    /// </summary>
    private void Shutdown()
    {
        if (shutdownRecorded) return;
        shutdownRecorded = true;
        Record(StatusCodes.ShutdownStarted);

        try { File.WriteAllText(StopMarkerPath(), string.Empty); } catch { }

        try
        {
            if (serverLauncher is { HasExited: false }) serverLauncher.Kill(entireProcessTree: true);
        }
        catch
        {
            // Already gone, or owned by another session.
        }

        foreach (var name in new[] { "node", "UsagePanel" })
        {
            foreach (var process in SafeProcessesByName(name))
            {
                try
                {
                    if (process.Id == Environment.ProcessId) continue;
                    if (!ProcessOwnership.IsUnderRoot(process.MainModule?.FileName, appRoot)) continue;
                    process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Unreadable or protected processes are left alone.
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        Record(StatusCodes.ShutdownComplete);
    }

    private static Process[] SafeProcessesByName(string name)
    {
        try { return Process.GetProcessesByName(name); }
        catch { return Array.Empty<Process>(); }
    }

    /// <summary>A non-fatal problem shown above a working dashboard.</summary>
    private void ShowNotice(StartupFault fault)
    {
        Record(fault.Status);
        noticeLabel.Text = fault.Message;
        noticeLabel.Visible = true;
        noticeLabel.BringToFront();
    }

    private void ShowFailure(StartupFault fault)
    {
        Record(fault.Status);
        Text = Program.MainWindowTitle + " - Could not open";
        browser.Visible = false;
        failureLabel.Text = fault.Message + Environment.NewLine + Environment.NewLine
            + "A private diagnostic status was saved. It contains no codes, credentials, prompts, or account details.";
        failureLabel.Visible = true;
        failureLabel.BringToFront();
    }
}
