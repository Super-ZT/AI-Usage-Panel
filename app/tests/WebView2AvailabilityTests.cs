using Xunit;

namespace UsagePanel.Core.Tests;

/// <summary>
/// The regression this file exists for: the shipped build briefly honoured
/// USAGE_PANEL_SMOKE_FORCE_WEBVIEW2_MISSING, so any environment variable could
/// strand a customer on an "install WebView2" screen that reinstalling cannot
/// clear — and the Windows proof used that same switch, so it demonstrated the
/// error screen without ever demonstrating detection.
/// </summary>
public sealed class WebView2AvailabilityTests
{
    /// Every name that has been, or could plausibly be, used as a kill switch.
    private static readonly string[] HostileVariables =
    {
        "USAGE_PANEL_SMOKE_FORCE_WEBVIEW2_MISSING",
        "USAGE_PANEL_FORCE_WEBVIEW2_MISSING",
        "USAGE_PANEL_WEBVIEW2_MISSING",
        "USAGE_PANEL_SMOKE",
        "USAGE_PANEL_TEST",
        "WEBVIEW2_MISSING",
        "CI"
    };

    [Fact]
    public void A_reported_version_means_the_runtime_is_present()
    {
        Assert.True(WebView2Availability.IsPresent(() => "120.0.2210.91"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void No_reported_version_means_the_runtime_is_missing(string? reported)
    {
        Assert.False(WebView2Availability.IsPresent(() => reported));
    }

    [Fact]
    public void A_loader_that_throws_means_the_runtime_is_missing()
    {
        // WebView2RuntimeNotFoundException, or a missing loader DLL: to the
        // customer these are the same situation.
        Assert.False(WebView2Availability.IsPresent(() => throw new InvalidOperationException("not found")));
    }

    [Fact]
    public void A_missing_probe_is_treated_as_missing_rather_than_present()
    {
        Assert.False(WebView2Availability.IsPresent(null!));
    }

    [Fact]
    public void No_environment_variable_can_force_the_runtime_to_look_missing()
    {
        // This is the defect, executed rather than grepped: with every hostile
        // variable set, a healthy loader must still report the runtime present.
        using var _ = new EnvironmentScope(HostileVariables, "1");

        Assert.True(WebView2Availability.IsPresent(() => "120.0.2210.91"),
            "a customer environment variable must not be able to hide the runtime");
    }

    [Fact]
    public void No_environment_variable_can_force_the_runtime_to_look_present()
    {
        // The opposite direction matters too: a variable must not paper over a
        // genuinely absent runtime and send the customer into a blank window.
        using var _ = new EnvironmentScope(HostileVariables, "0");

        Assert.False(WebView2Availability.IsPresent(() => null));
    }

    [Fact]
    public void The_verdict_follows_the_loader_across_every_hostile_value()
    {
        foreach (var value in new[] { "1", "0", "true", "false", "yes", "" })
        {
            using var _ = new EnvironmentScope(HostileVariables, value);

            Assert.True(WebView2Availability.IsPresent(() => "120.0.2210.91"), value);
            Assert.False(WebView2Availability.IsPresent(() => null), value);
        }
    }

    [Fact]
    public void The_probe_is_consulted_exactly_once_per_question()
    {
        var calls = 0;
        WebView2Availability.IsPresent(() => { calls++; return "120.0"; });

        Assert.Equal(1, calls);
    }

    private sealed class EnvironmentScope : IDisposable
    {
        private readonly Dictionary<string, string?> previous = new();

        public EnvironmentScope(IEnumerable<string> names, string value)
        {
            foreach (var name in names)
            {
                previous[name] = Environment.GetEnvironmentVariable(name);
                Environment.SetEnvironmentVariable(name, value);
            }
        }

        public void Dispose()
        {
            foreach (var (name, value) in previous)
                Environment.SetEnvironmentVariable(name, value);
        }
    }
}
