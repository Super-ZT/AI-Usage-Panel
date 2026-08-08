using System.Net.Http.Headers;
using System.Net.Sockets;

namespace UsagePanel.Core;

public enum PortState
{
    /// <summary>Nothing is listening on the panel port.</summary>
    Free,

    /// <summary>The Usage Panel local server is listening and answering.</summary>
    OwnedByPanel,

    /// <summary>Something is listening, but it is not the Usage Panel server.</summary>
    ForeignListener
}

/// <summary>
/// Classifies what is on the panel port. The distinction matters: if a
/// different program owns 8899 our server can never bind it, so waiting is
/// pointless and terminating the other program would be unacceptable. We only
/// ever look; we never kill anything we did not start.
/// </summary>
public sealed class PanelProbe
{
    private readonly string host;
    private readonly int port;
    private readonly TimeSpan timeout;

    public PanelProbe(string host = "127.0.0.1", int port = 8899, TimeSpan? timeout = null)
    {
        this.host = host;
        this.port = port;
        this.timeout = timeout ?? TimeSpan.FromMilliseconds(1500);
    }

    public string SyncUrl => $"http://{host}:{port}/api/sync";

    public async Task<PortState> ClassifyAsync(CancellationToken cancellationToken = default)
    {
        if (!await CanConnectAsync(cancellationToken)) return PortState.Free;
        return await AnswersAsPanelAsync(cancellationToken)
            ? PortState.OwnedByPanel
            : PortState.ForeignListener;
    }

    /// <summary>True when a TCP connection to the panel port is accepted.</summary>
    public async Task<bool> CanConnectAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var client = new TcpClient();
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(timeout);
            await client.ConnectAsync(host, port, cts.Token);
            return client.Connected;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// True only when the listener replies to the panel's own status route with
    /// a JSON document, which a generic listener on the same port will not do.
    /// </summary>
    public async Task<bool> AnswersAsPanelAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var client = new HttpClient { Timeout = timeout };
            using var response = await client.GetAsync(SyncUrl, cancellationToken);
            return response.IsSuccessStatusCode && IsJson(response.Content.Headers.ContentType);
        }
        catch
        {
            return false;
        }
    }

    public static bool IsJson(MediaTypeHeaderValue? contentType) =>
        contentType?.MediaType is not null
        && contentType.MediaType.Contains("json", StringComparison.OrdinalIgnoreCase);
}
