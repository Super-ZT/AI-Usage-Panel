using Xunit;

namespace UsagePanel.Core.Tests;

public sealed class InstallPayloadTests : IDisposable
{
    private readonly string root =
        Path.Combine(Path.GetTempPath(), "usage-panel-payload", Guid.NewGuid().ToString("N"));

    public InstallPayloadTests() => Directory.CreateDirectory(root);

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch { }
    }

    private void WriteCompleteInstall(bool withBundledNode)
    {
        foreach (var name in InstallPayload.RequiredFiles)
            File.WriteAllText(Path.Combine(root, name), "content");

        if (withBundledNode)
        {
            Directory.CreateDirectory(Path.Combine(root, "node"));
            File.WriteAllText(Path.Combine(root, "node", "node.exe"), "binary");
        }
    }

    [Fact]
    public void A_complete_customer_install_is_ok()
    {
        WriteCompleteInstall(withBundledNode: true);
        Assert.Equal(PayloadState.Ok, InstallPayload.Inspect(root));
    }

    [Theory]
    [InlineData("start-panel.cmd")]
    [InlineData("refresher.js")]
    [InlineData("dashboard.html")]
    [InlineData("package.json")]
    public void Any_missing_application_file_is_detected(string removed)
    {
        WriteCompleteInstall(withBundledNode: true);
        File.Delete(Path.Combine(root, removed));

        Assert.Equal(PayloadState.Missing, InstallPayload.Inspect(root));
    }

    [Fact]
    public void A_truncated_file_counts_as_missing()
    {
        // An interrupted upgrade leaves zero-byte files behind; the customer's
        // symptom is identical to a missing file, so the remedy must be too.
        WriteCompleteInstall(withBundledNode: true);
        File.WriteAllText(Path.Combine(root, "refresher.js"), string.Empty);

        Assert.Equal(PayloadState.Missing, InstallPayload.Inspect(root));
    }

    [Fact]
    public void A_missing_runtime_is_its_own_state()
    {
        WriteCompleteInstall(withBundledNode: false);
        Assert.Equal(PayloadState.NodeMissing, InstallPayload.Inspect(root, nodeOnPath: false));
    }

    [Fact]
    public void A_source_install_may_rely_on_a_machine_wide_runtime()
    {
        WriteCompleteInstall(withBundledNode: false);
        Assert.Equal(PayloadState.Ok, InstallPayload.Inspect(root, nodeOnPath: true));
    }

    [Fact]
    public void An_empty_directory_is_missing_rather_than_ok()
    {
        Assert.Equal(PayloadState.Missing, InstallPayload.Inspect(root));
    }
}
