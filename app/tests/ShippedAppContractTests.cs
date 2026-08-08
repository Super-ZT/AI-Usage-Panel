using System.Text.RegularExpressions;
using Xunit;

namespace UsagePanel.Core.Tests;

/// <summary>
/// A behavioural test can prove the decision function ignores the environment,
/// but not that the shipped window never consults the environment before
/// asking it. These read the exact sources compiled into the customer binary.
/// They fail closed: if the source cannot be found, that is a failure, not a
/// pass.
/// </summary>
public sealed class ShippedAppContractTests
{
    private const string RetiredOverride = "USAGE_PANEL_SMOKE_FORCE_WEBVIEW2_MISSING";

    private static string AppDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "host.cs");
            if (File.Exists(candidate) && Directory.Exists(Path.Combine(directory.FullName, "core")))
                return directory.FullName;
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "the shipped application sources were not found; this contract cannot pass unverified");
    }

    private static IEnumerable<string> ShippedSourceFiles()
    {
        var root = AppDirectory();
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            // app/tests is excluded from the shipped build by UsagePanel.csproj.
            var relative = Path.GetRelativePath(root, file);
            if (relative.StartsWith("tests" + Path.DirectorySeparatorChar, StringComparison.Ordinal)) continue;
            if (relative.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")) continue;
            if (relative.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")) continue;
            yield return file;
        }
    }

    [Fact]
    public void The_shipped_sources_exist_and_are_readable()
    {
        var files = ShippedSourceFiles().ToList();

        Assert.Contains(files, f => Path.GetFileName(f) == "host.cs");
        Assert.Contains(files, f => Path.GetFileName(f) == "WebView2Availability.cs");
        Assert.All(files, f => Assert.True(new FileInfo(f).Length > 0, f));
    }

    [Fact]
    public void The_retired_force_missing_override_is_gone_from_every_shipped_source()
    {
        var offenders = ShippedSourceFiles()
            .Where(f => File.ReadAllText(f).Contains(RetiredOverride, StringComparison.OrdinalIgnoreCase))
            .Select(Path.GetFileName)
            .ToList();

        Assert.True(offenders.Count == 0,
            RetiredOverride + " must not exist in the customer binary; found in: " + string.Join(", ", offenders));
    }

    [Fact]
    public void Browser_runtime_detection_reads_no_environment_variable()
    {
        // The whole method body, so a variable read anywhere inside it counts.
        var host = File.ReadAllText(Path.Combine(AppDirectory(), "host.cs"));
        var detection = Regex.Match(
            host,
            @"private static bool WebView2Available\(\)(?<body>.*?)(?=\n    private |\n\}\s*$)",
            RegexOptions.Singleline);

        Assert.True(detection.Success, "WebView2Available() was not found in host.cs");
        var body = detection.Groups["body"].Value;

        AssertReadsNoEnvironment(body, "WebView2Available()");
        Assert.Contains("WebView2Availability.IsPresent", body);
    }

    [Fact]
    public void The_detection_helper_itself_reads_no_environment_variable()
    {
        var helper = File.ReadAllText(Path.Combine(AppDirectory(), "core", "WebView2Availability.cs"));

        AssertReadsNoEnvironment(helper, "WebView2Availability");
    }

    [Fact]
    public void Enrollment_still_passes_the_one_time_code_out_of_band()
    {
        // Guards the neighbouring privacy property while we are in this file:
        // the code must never appear as a process argument.
        var host = File.ReadAllText(Path.Combine(AppDirectory(), "host.cs"));

        Assert.Contains("enroll-panel.ps1", host);
        Assert.DoesNotContain("--code ", host);
        Assert.DoesNotContain("ArgumentList.Add(code", host);
    }

    /// <summary>
    /// Rejects reads of the process environment without tripping over the
    /// WebView2 type name, which legitimately ends in "Environment".
    /// </summary>
    private static void AssertReadsNoEnvironment(string source, string what)
    {
        Assert.DoesNotContain("GetEnvironmentVariable", source);
        Assert.False(Regex.IsMatch(source, @"(?<![A-Za-z0-9_])Environment\s*\."),
            what + " must not read the process environment");
    }
}
