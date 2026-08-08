namespace UsagePanel.Core;

/// <summary>A status word plus the plain-English sentence shown in the window.</summary>
public sealed record StartupFault(string Status, string Message);

/// <summary>
/// The startup decision table, kept free of Windows Forms so it can be tested
/// directly. Each distinct cause gets its own status and its own remedy: the
/// v1.0.2 failure was one generic "reinstall it" message standing in for
/// several unrelated problems, most of which reinstalling cannot fix.
/// </summary>
public static class StartupPlan
{
    public const string WebView2MissingMessage =
        "Usage Panel needs the Microsoft Edge WebView2 runtime, which most Windows PCs already have.\n"
        + "Install \"Microsoft Edge WebView2 Runtime\" from Microsoft, then open Usage Panel again.\n"
        + "Reinstalling Usage Panel will not add it.";

    public const string PayloadMissingMessage =
        "Some Usage Panel files are missing, so it cannot start.\n"
        + "Reinstall Usage Panel, then open it again.";

    public const string NodeMissingMessage =
        "Usage Panel could not find the runtime it needs to read your usage.\n"
        + "Reinstall Usage Panel, then open it again.";

    public const string PortInUseMessage =
        "Another program on this computer is already using port 8899, which Usage Panel needs.\n"
        + "Close that program, or restart the computer, then open Usage Panel again.\n"
        + "Usage Panel will not close another program for you.";

    public const string ServerFailedMessage =
        "Usage Panel could not start its local service.\n"
        + "Restart the computer and open Usage Panel again. If it still fails, reinstall Usage Panel.";

    public const string WebViewFailedMessage =
        "Usage Panel started, but its dashboard could not load.\n"
        + "Close this window and open Usage Panel again.";

    public const string EnrollmentFailedMessage =
        "Usage Panel could not open the linking window. Your usage is still being collected on this computer. "
        + "Use \"Link this computer\" in the Start Menu to try again.";

    public const string NetworkUnavailableMessage =
        "This computer appears to be offline, so it cannot be linked to the Super ZT portal yet. "
        + "Usage Panel keeps working on this computer; link it once you are back online.";

    /// <summary>
    /// Everything knowable before we try to start anything. Returns null when
    /// startup may proceed.
    /// </summary>
    public static StartupFault? PreFlight(PayloadState payload, PortState port, bool webView2Available)
    {
        if (!webView2Available)
            return new StartupFault(StatusCodes.WebView2Missing, WebView2MissingMessage);

        if (payload == PayloadState.Missing)
            return new StartupFault(StatusCodes.PayloadMissing, PayloadMissingMessage);

        // A server already answering on the port makes the local runtime moot.
        if (payload == PayloadState.NodeMissing && port != PortState.OwnedByPanel)
            return new StartupFault(StatusCodes.NodeMissing, NodeMissingMessage);

        if (port == PortState.ForeignListener)
            return new StartupFault(StatusCodes.PortInUseForeign, PortInUseMessage);

        return null;
    }

    /// <summary>The verdict once the local server has had its chance to start.</summary>
    public static StartupFault? AfterServerStart(bool serverReady) =>
        serverReady ? null : new StartupFault(StatusCodes.ServerFailed, ServerFailedMessage);

    /// <summary>
    /// A failed navigation inside a healthy app: the window stays, the message
    /// changes.
    /// </summary>
    public static StartupFault NavigationFailed() =>
        new(StatusCodes.WebViewFailed, WebViewFailedMessage);

    /// <summary>
    /// Linking problems never block the local dashboard, so they surface as a
    /// notice above a working panel rather than replacing it.
    /// </summary>
    public static StartupFault EnrollmentFailed() =>
        new(StatusCodes.EnrollmentFailed, EnrollmentFailedMessage);

    public static StartupFault NetworkUnavailable() =>
        new(StatusCodes.NetworkUnavailable, NetworkUnavailableMessage);
}
