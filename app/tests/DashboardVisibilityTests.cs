using Xunit;

namespace UsagePanel.Core.Tests;

/// <summary>
/// These are the regression tests for the actual v1.0.2/v1.0.3 defect: a
/// launcher that reports success while the customer sees nothing. Each case
/// removes one thing a customer needs and requires the recorded status to
/// change to DASHBOARD_HIDDEN.
/// </summary>
public sealed class DashboardVisibilityTests
{
    private static WindowSurface Healthy() => new(
        FormVisible: true,
        FormMinimized: false,
        FormHandleVisible: true,
        DashboardControlVisible: true,
        FailureMessageVisible: false,
        DashboardWidth: 1520,
        DashboardHeight: 940,
        DashboardHandleVisible: true);

    [Fact]
    public void A_dashboard_the_customer_can_see_is_reported_visible()
    {
        Assert.True(DashboardVisibility.IsOnScreen(Healthy()));
        Assert.Equal(StatusCodes.DashboardVisible, DashboardVisibility.StatusFor(Healthy()));
    }

    [Fact]
    public void Forgetting_to_reveal_the_dashboard_is_reported_hidden()
    {
        // The exact mutation that left v1.0.2's checks green: the window opens,
        // the navigation succeeds, and the dashboard control is never shown.
        var surface = Healthy() with { DashboardControlVisible = false };

        Assert.Equal(StatusCodes.DashboardHidden, DashboardVisibility.StatusFor(surface));
    }

    [Fact]
    public void A_failure_message_still_covering_the_dashboard_is_reported_hidden()
    {
        var surface = Healthy() with { FailureMessageVisible = true };

        Assert.Equal(StatusCodes.DashboardHidden, DashboardVisibility.StatusFor(surface));
    }

    [Fact]
    public void A_minimized_window_is_not_a_visible_dashboard()
    {
        Assert.Equal(StatusCodes.DashboardHidden,
            DashboardVisibility.StatusFor(Healthy() with { FormMinimized = true }));
    }

    [Fact]
    public void A_window_hidden_at_the_operating_system_level_is_reported_hidden()
    {
        Assert.Equal(StatusCodes.DashboardHidden,
            DashboardVisibility.StatusFor(Healthy() with { FormHandleVisible = false }));
        Assert.Equal(StatusCodes.DashboardHidden,
            DashboardVisibility.StatusFor(Healthy() with { DashboardHandleVisible = false }));
    }

    [Theory]
    [InlineData(0, 940)]
    [InlineData(1520, 0)]
    [InlineData(0, 0)]
    public void A_dashboard_collapsed_to_nothing_is_reported_hidden(int width, int height)
    {
        var surface = Healthy() with { DashboardWidth = width, DashboardHeight = height };

        Assert.Equal(StatusCodes.DashboardHidden, DashboardVisibility.StatusFor(surface));
    }

    [Fact]
    public void An_unreadable_surface_defaults_to_hidden_rather_than_visible()
    {
        // default(WindowSurface) is what the host records if reading the real
        // window state throws: fail closed, never claim a visible dashboard.
        Assert.Equal(StatusCodes.DashboardHidden, DashboardVisibility.StatusFor(default));
    }

    [Fact]
    public void Every_single_requirement_is_load_bearing()
    {
        var healthy = Healthy();
        WindowSurface[] broken =
        {
            healthy with { FormVisible = false },
            healthy with { FormMinimized = true },
            healthy with { FormHandleVisible = false },
            healthy with { DashboardControlVisible = false },
            healthy with { FailureMessageVisible = true },
            healthy with { DashboardWidth = 0 },
            healthy with { DashboardHeight = 0 },
            healthy with { DashboardHandleVisible = false }
        };

        Assert.All(broken, surface => Assert.False(DashboardVisibility.IsOnScreen(surface)));
    }
}
