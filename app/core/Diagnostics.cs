namespace UsagePanel.Core;

/// <summary>
/// Append-only status log. Writes a UTC timestamp and one allowlisted status
/// word per line, and nothing else. Keeps the last <see cref="MaxLines"/> lines.
/// Never throws: a launcher must not die because it could not write a log.
/// </summary>
public sealed class Diagnostics
{
    public const int MaxLines = 100;

    private readonly string path;
    private readonly object gate = new();

    public Diagnostics(string path) => this.path = path;

    public string Path => path;

    public void Record(string? status)
    {
        var safe = StatusCodes.Sanitize(status);
        try
        {
            lock (gate)
            {
                var directory = System.IO.Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.AppendAllText(path, FormatLine(safe) + Environment.NewLine);
                var lines = File.ReadAllLines(path);
                if (lines.Length > MaxLines) File.WriteAllLines(path, lines[^MaxLines..]);
            }
        }
        catch
        {
            // A diagnostic log is best-effort by design.
        }
    }

    public static string FormatLine(string status) =>
        DateTimeOffset.UtcNow.ToString("O") + " " + StatusCodes.Sanitize(status);
}
