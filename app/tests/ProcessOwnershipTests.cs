using Xunit;

namespace UsagePanel.Core.Tests;

/// <summary>
/// Shutdown kills processes, so the boundary of "ours" is a safety property,
/// not a detail. The neighbouring-folder case is the one that would let a
/// prefix match reach into somebody else's installation.
/// </summary>
public sealed class ProcessOwnershipTests
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), "Programs", "Usage Panel");

    [Fact]
    public void The_bundled_runtime_is_ours()
    {
        Assert.True(ProcessOwnership.IsUnderRoot(Path.Combine(Root, "node", "node.exe"), Root));
    }

    [Fact]
    public void A_neighbouring_folder_sharing_our_prefix_is_not_ours()
    {
        var neighbour = Path.Combine(Path.GetTempPath(), "Programs", "Usage Panel Old", "node", "node.exe");
        Assert.False(ProcessOwnership.IsUnderRoot(neighbour, Root));
    }

    [Fact]
    public void An_unrelated_runtime_elsewhere_is_not_ours()
    {
        Assert.False(ProcessOwnership.IsUnderRoot(
            Path.Combine(Path.GetTempPath(), "nodejs", "node.exe"), Root));
    }

    [Fact]
    public void The_install_directory_itself_is_not_a_process_inside_it()
    {
        Assert.False(ProcessOwnership.IsUnderRoot(Root, Root));
    }

    [Fact]
    public void A_traversal_that_escapes_the_root_is_not_ours()
    {
        var escaped = Path.Combine(Root, "..", "Other", "node.exe");
        Assert.False(ProcessOwnership.IsUnderRoot(escaped, Root));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void An_unreadable_process_path_is_never_ours(string? path)
    {
        Assert.False(ProcessOwnership.IsUnderRoot(path, Root));
    }

    [Fact]
    public void A_trailing_separator_on_the_root_changes_nothing()
    {
        Assert.True(ProcessOwnership.IsUnderRoot(
            Path.Combine(Root, "UsagePanel.exe"), Root + Path.DirectorySeparatorChar));
    }
}
