namespace UsagePanel.Core;

/// <summary>
/// Every value the launcher is allowed to write to its diagnostic file.
///
/// This is an allowlist, not a convention. <see cref="Diagnostics"/> refuses
/// anything outside this set, so a username, install path, one-time code,
/// device credential, token, prompt, or raw exception string cannot reach the
/// log even if a future caller passes one in by mistake.
/// </summary>
public static class StatusCodes
{
    public const string LaunchStarted = "LAUNCH_STARTED";
    public const string WindowVisible = "WINDOW_VISIBLE";
    public const string StaleStopCleared = "STALE_STOP_CLEARED";

    public const string PayloadMissing = "PAYLOAD_MISSING";
    public const string NodeMissing = "NODE_MISSING";

    public const string PortInUse = "PORT_IN_USE";
    public const string ServerAlreadyReady = "SERVER_ALREADY_READY";
    public const string ServerStartRequested = "SERVER_START_REQUESTED";
    public const string ServerReady = "SERVER_READY";
    public const string ServerFailed = "SERVER_FAILED";

    public const string WebView2Missing = "WEBVIEW2_MISSING";
    public const string WebViewFailed = "WEBVIEW_FAILED";
    public const string DashboardVisible = "DASHBOARD_VISIBLE";
    public const string DashboardHidden = "DASHBOARD_HIDDEN";

    public const string EnrollmentStarted = "ENROLLMENT_STARTED";
    public const string EnrollmentFinished = "ENROLLMENT_FINISHED";
    public const string EnrollmentFailed = "ENROLLMENT_FAILED";
    public const string NetworkUnavailable = "NETWORK_UNAVAILABLE";

    public const string UnexpectedError = "UNEXPECTED_ERROR";

    public const string SecondInstanceFocused = "SECOND_INSTANCE_FOCUSED";
    public const string ShutdownStarted = "SHUTDOWN_STARTED";
    public const string ShutdownComplete = "SHUTDOWN_COMPLETE";

    /// <summary>Written in place of any value that is not on the allowlist.</summary>
    public const string Unknown = "UNKNOWN_STATUS";

    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    {
        LaunchStarted, WindowVisible, StaleStopCleared,
        PayloadMissing, NodeMissing,
        PortInUse, ServerAlreadyReady, ServerStartRequested, ServerReady, ServerFailed,
        WebView2Missing, WebViewFailed, DashboardVisible, DashboardHidden,
        EnrollmentStarted, EnrollmentFinished, EnrollmentFailed, NetworkUnavailable,
        UnexpectedError, SecondInstanceFocused, ShutdownStarted, ShutdownComplete,
        Unknown
    };

    public static bool IsAllowed(string? status) => status is not null && Allowed.Contains(status);

    public static IReadOnlyCollection<string> All => Allowed;

    /// <summary>Returns <paramref name="status"/> if allowlisted, otherwise <see cref="Unknown"/>.</summary>
    public static string Sanitize(string? status) => IsAllowed(status) ? status! : Unknown;
}
