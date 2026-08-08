using System.Net.Sockets;

namespace UsagePanel.Core;

/// <summary>
/// A short reachability check used only to tell "you are offline" apart from
/// "linking is broken". It opens and immediately closes a TCP connection and
/// sends nothing: no code, credential, or identity leaves the machine here.
/// </summary>
public sealed class NetworkProbe
{
    private readonly string host;
    private readonly int port;
    private readonly TimeSpan timeout;

    public NetworkProbe(string host = "super-zt.com", int port = 443, TimeSpan? timeout = null)
    {
        this.host = host;
        this.port = port;
        this.timeout = timeout ?? TimeSpan.FromSeconds(4);
    }

    public async Task<bool> CanReachAsync(CancellationToken cancellationToken = default)
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
}
