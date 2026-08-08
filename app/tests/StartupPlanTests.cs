using Xunit;

namespace UsagePanel.Core.Tests;

public sealed class StartupPlanTests
{
    [Fact]
    public void A_healthy_installation_proceeds()
    {
        Assert.Null(StartupPlan.PreFlight(PayloadState.Ok, PortState.Free, webView2Available: true));
    }

    [Fact]
    public void A_missing_browser_runtime_is_named_and_does_not_advise_reinstalling_the_app()
    {
        var fault = StartupPlan.PreFlight(PayloadState.Ok, PortState.Free, webView2Available: false);

        Assert.NotNull(fault);
        Assert.Equal(StatusCodes.WebView2Missing, fault!.Status);
        Assert.Contains("WebView2", fault.Message);
        Assert.DoesNotContain("Reinstall Usage Panel, then open it again", fault.Message);
    }

    [Fact]
    public void A_foreign_program_on_the_port_is_reported_and_never_terminated()
    {
        var fault = StartupPlan.PreFlight(PayloadState.Ok, PortState.ForeignListener, webView2Available: true);

        Assert.NotNull(fault);
        Assert.Equal(StatusCodes.PortInUse, fault!.Status);
        Assert.Contains("8899", fault.Message);
        Assert.Contains("will not close another program", fault.Message);
    }

    [Fact]
    public void Missing_files_and_a_missing_runtime_are_different_faults()
    {
        var missingFiles = StartupPlan.PreFlight(PayloadState.Missing, PortState.Free, true);
        var missingRuntime = StartupPlan.PreFlight(PayloadState.NodeMissing, PortState.Free, true);

        Assert.Equal(StatusCodes.PayloadMissing, missingFiles!.Status);
        Assert.Equal(StatusCodes.NodeMissing, missingRuntime!.Status);
        Assert.NotEqual(missingFiles.Message, missingRuntime.Message);
    }

    [Fact]
    public void A_server_already_answering_makes_a_missing_local_runtime_irrelevant()
    {
        Assert.Null(StartupPlan.PreFlight(PayloadState.NodeMissing, PortState.OwnedByPanel, true));
    }

    [Fact]
    public void A_missing_browser_runtime_is_reported_before_anything_else()
    {
        // Otherwise the customer fixes the file problem and hits a second wall.
        var fault = StartupPlan.PreFlight(PayloadState.Missing, PortState.ForeignListener, webView2Available: false);

        Assert.Equal(StatusCodes.WebView2Missing, fault!.Status);
    }

    [Fact]
    public void A_server_that_never_becomes_ready_is_a_visible_failure()
    {
        Assert.Null(StartupPlan.AfterServerStart(serverReady: true));
        Assert.Equal(StatusCodes.ServerFailed, StartupPlan.AfterServerStart(serverReady: false)!.Status);
    }

    [Fact]
    public void Linking_problems_have_their_own_status_and_do_not_mention_the_browser()
    {
        Assert.Equal(StatusCodes.EnrollmentFailed, StartupPlan.EnrollmentFailed().Status);
        Assert.Equal(StatusCodes.NetworkUnavailable, StartupPlan.NetworkUnavailable().Status);
        Assert.DoesNotContain("dashboard could not load", StartupPlan.EnrollmentFailed().Message);
    }

    [Fact]
    public void Every_fault_carries_an_allowlisted_status_and_a_real_sentence()
    {
        StartupFault[] faults =
        {
            StartupPlan.PreFlight(PayloadState.Ok, PortState.Free, false)!,
            StartupPlan.PreFlight(PayloadState.Missing, PortState.Free, true)!,
            StartupPlan.PreFlight(PayloadState.NodeMissing, PortState.Free, true)!,
            StartupPlan.PreFlight(PayloadState.Ok, PortState.ForeignListener, true)!,
            StartupPlan.AfterServerStart(false)!,
            StartupPlan.NavigationFailed(),
            StartupPlan.EnrollmentFailed(),
            StartupPlan.NetworkUnavailable()
        };

        foreach (var fault in faults)
        {
            Assert.True(StatusCodes.IsAllowed(fault.Status), fault.Status + " is not allowlisted");
            Assert.True(fault.Message.Length > 40, "every failure needs a usable explanation");
            Assert.DoesNotContain("Exception", fault.Message);
            Assert.DoesNotContain("null", fault.Message);
        }
    }

    [Fact]
    public void Each_distinct_cause_produces_a_distinct_message()
    {
        // v1.0.2 answered "Please reinstall it" to several unrelated problems.
        string[] messages =
        {
            StartupPlan.WebView2MissingMessage,
            StartupPlan.PayloadMissingMessage,
            StartupPlan.NodeMissingMessage,
            StartupPlan.PortInUseMessage,
            StartupPlan.ServerFailedMessage,
            StartupPlan.WebViewFailedMessage,
            StartupPlan.EnrollmentFailedMessage,
            StartupPlan.NetworkUnavailableMessage
        };

        Assert.Equal(messages.Length, messages.Distinct().Count());
    }
}
