namespace UsagePanel.Core;

/// <summary>
/// Decides whether a running executable belongs to this installation.
///
/// Shutdown terminates only processes started from inside the install
/// directory, so an unrelated Node application on the same machine is never
/// touched. The comparison is directory-boundary aware: a neighbouring folder
/// whose name merely starts with the same characters is not "inside" us.
/// </summary>
public static class ProcessOwnership
{
    public static bool IsUnderRoot(string? executablePath, string? root)
    {
        if (string.IsNullOrWhiteSpace(executablePath) || string.IsNullOrWhiteSpace(root)) return false;

        string normalizedRoot, normalizedPath;
        try
        {
            normalizedRoot = Normalize(root!);
            normalizedPath = Normalize(executablePath!);
        }
        catch
        {
            return false;
        }

        if (normalizedRoot.Length == 0) return false;
        if (!normalizedRoot.EndsWith(Path.DirectorySeparatorChar))
            normalizedRoot += Path.DirectorySeparatorChar;

        return normalizedPath.StartsWith(normalizedRoot, PathComparison);
    }

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static string Normalize(string value)
    {
        var full = Path.GetFullPath(value.Trim());
        return full.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar)
                   .TrimEnd(Path.DirectorySeparatorChar);
    }
}
