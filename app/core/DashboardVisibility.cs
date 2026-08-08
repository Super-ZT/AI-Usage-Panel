namespace UsagePanel.Core;

/// <summary>
/// What the customer can actually see.
///
/// v1.0.2 passed its Windows check because the application wrote
/// "the dashboard is ready" into its own log. The log agreed with the code's
/// intention and disagreed with the screen. This type takes the real Win32
/// state as input, so the recorded status is a measurement: remove the code
/// that reveals the dashboard and the status becomes DASHBOARD_HIDDEN, which
/// the Windows smoke test fails on.
/// </summary>
public readonly record struct WindowSurface(
    bool FormVisible,
    bool FormMinimized,
    bool FormHandleVisible,
    bool DashboardControlVisible,
    bool FailureMessageVisible,
    int DashboardWidth,
    int DashboardHeight,
    bool DashboardHandleVisible);

public static class DashboardVisibility
{
    /// <summary>True only when a customer looking at the screen would see the dashboard.</summary>
    public static bool IsOnScreen(in WindowSurface surface) =>
        surface.FormVisible
        && !surface.FormMinimized
        && surface.FormHandleVisible
        && surface.DashboardControlVisible
        && !surface.FailureMessageVisible
        && surface.DashboardWidth > 0
        && surface.DashboardHeight > 0
        && surface.DashboardHandleVisible;

    public static string StatusFor(in WindowSurface surface) =>
        IsOnScreen(surface) ? StatusCodes.DashboardVisible : StatusCodes.DashboardHidden;
}
