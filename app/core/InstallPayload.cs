namespace UsagePanel.Core;

public enum PayloadState
{
    /// <summary>Everything the local server needs is present.</summary>
    Ok,

    /// <summary>One of the installed application files is missing or empty.</summary>
    Missing,

    /// <summary>Application files are present but no Node runtime can be found.</summary>
    NodeMissing
}

/// <summary>
/// Answers "is this installation complete enough to start the local server?"
/// before we spend thirty seconds waiting for a server that can never start.
/// A missing or truncated file and a missing runtime are different customer
/// problems with different remedies, so they are reported separately.
/// </summary>
public static class InstallPayload
{
    public static readonly string[] RequiredFiles =
    {
        "start-panel.cmd",
        "refresher.js",
        "dashboard.html",
        "package.json"
    };

    /// <param name="root">The installation directory.</param>
    /// <param name="nodeOnPath">
    /// Whether a machine-wide Node runtime is reachable. Source installs are
    /// allowed to rely on that; customer installs carry a bundled runtime.
    /// </param>
    public static PayloadState Inspect(string root, bool nodeOnPath = false)
    {
        foreach (var name in RequiredFiles)
        {
            var file = Path.Combine(root, name);
            if (!File.Exists(file)) return PayloadState.Missing;
            try
            {
                if (new FileInfo(file).Length == 0) return PayloadState.Missing;
            }
            catch
            {
                return PayloadState.Missing;
            }
        }

        var bundled = Path.Combine(root, "node", "node.exe");
        if (File.Exists(bundled)) return PayloadState.Ok;

        return nodeOnPath ? PayloadState.Ok : PayloadState.NodeMissing;
    }
}
