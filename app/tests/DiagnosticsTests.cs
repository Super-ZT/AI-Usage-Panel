using Xunit;

namespace UsagePanel.Core.Tests;

/// <summary>
/// The privacy guarantee is enforced by an allowlist, so these tests push the
/// exact values we promise never to write and prove they cannot land on disk.
/// </summary>
public sealed class DiagnosticsTests : IDisposable
{
    private readonly string directory =
        Path.Combine(Path.GetTempPath(), "usage-panel-tests", Guid.NewGuid().ToString("N"));

    private string LogPath => Path.Combine(directory, "launcher.log");

    public void Dispose()
    {
        try { Directory.Delete(directory, recursive: true); } catch { }
    }

    [Fact]
    public void Writes_an_allowlisted_status_with_a_timestamp()
    {
        new Diagnostics(LogPath).Record(StatusCodes.ServerReady);

        var line = Assert.Single(File.ReadAllLines(LogPath));
        Assert.EndsWith(" " + StatusCodes.ServerReady, line);
        Assert.True(DateTimeOffset.TryParse(line.Split(' ')[0], out _), "the line must start with a timestamp");
    }

    [Theory]
    [InlineData("C:\\Users\\HumanZT\\AppData\\Roaming")]
    [InlineData("one-time code 4821-99")]
    [InlineData("Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")]
    [InlineData("github_pat_11ABCDEF")]
    [InlineData("System.Net.Http.HttpRequestException: No such host is known (super-zt.com:443)")]
    [InlineData("deviceCredential=abc123")]
    public void Refuses_anything_that_is_not_an_allowlisted_status(string leak)
    {
        var diagnostics = new Diagnostics(LogPath);

        diagnostics.Record(leak);

        var contents = File.ReadAllText(LogPath);
        Assert.Contains(StatusCodes.Unknown, contents);
        Assert.DoesNotContain(leak, contents);
    }

    [Fact]
    public void No_allowlisted_status_contains_anything_but_capitals_and_underscores()
    {
        foreach (var status in StatusCodes.All)
            Assert.Matches("^[A-Z0-9_]+$", status);
    }

    [Fact]
    public void Keeps_only_the_last_hundred_lines()
    {
        var diagnostics = new Diagnostics(LogPath);
        for (var i = 0; i < Diagnostics.MaxLines + 25; i++) diagnostics.Record(StatusCodes.LaunchStarted);

        Assert.Equal(Diagnostics.MaxLines, File.ReadAllLines(LogPath).Length);
    }

    [Fact]
    public void An_unwritable_path_does_not_throw()
    {
        // The launcher must survive a broken log, not die with it. A file
        // standing where a directory is expected is refused by the kernel for
        // every user, including root.
        var blocker = Path.Combine(directory, "blocker");
        Directory.CreateDirectory(directory);
        File.WriteAllText(blocker, "not a directory");

        var record = new Diagnostics(Path.Combine(blocker, "launcher.log"));

        record.Record(StatusCodes.LaunchStarted);
        Assert.False(File.Exists(Path.Combine(blocker, "launcher.log")));
    }
}
