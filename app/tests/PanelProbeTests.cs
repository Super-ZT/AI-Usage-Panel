using System.Net;
using System.Net.Sockets;
using System.Text;
using Xunit;

namespace UsagePanel.Core.Tests;

/// <summary>
/// Run against real listeners on real sockets rather than a stubbed client:
/// the property under test is how an actual foreign program on the panel port
/// is distinguished from our own server.
/// </summary>
public sealed class PanelProbeTests
{
    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static PanelProbe ProbeFor(int port) =>
        new("127.0.0.1", port, TimeSpan.FromSeconds(2));

    [Fact]
    public async Task Reports_free_when_nothing_is_listening()
    {
        Assert.Equal(PortState.Free, await ProbeFor(FreePort()).ClassifyAsync());
    }

    [Fact]
    public async Task Reports_owned_when_the_panel_status_route_answers_with_json()
    {
        var port = FreePort();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var serving = ServeOnce(listener, "application/json",
            """{"enabled":false,"endpoint":null,"configured":false}""");

        var state = await ProbeFor(port).ClassifyAsync();

        listener.Stop();
        await serving;
        Assert.Equal(PortState.OwnedByPanel, state);
    }

    [Fact]
    public async Task Reports_foreign_when_another_http_server_holds_the_port()
    {
        var port = FreePort();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var serving = ServeOnce(listener, "text/html", "<html><body>some other app</body></html>");

        var state = await ProbeFor(port).ClassifyAsync();

        listener.Stop();
        await serving;
        Assert.Equal(PortState.ForeignListener, state);
    }

    [Fact]
    public async Task Reports_foreign_when_the_listener_does_not_speak_http_at_all()
    {
        var port = FreePort();
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        var accepting = Task.Run(async () =>
        {
            try
            {
                using var client = await listener.AcceptTcpClientAsync();
                var noise = Encoding.ASCII.GetBytes("NOT-HTTP\r\n");
                await client.GetStream().WriteAsync(noise);
            }
            catch { }
        });

        var state = await ProbeFor(port).ClassifyAsync();

        listener.Stop();
        await accepting;
        Assert.Equal(PortState.ForeignListener, state);
    }

    private static Task ServeOnce(HttpListener listener, string contentType, string body) =>
        Task.Run(async () =>
        {
            try
            {
                var context = await listener.GetContextAsync();
                var bytes = Encoding.UTF8.GetBytes(body);
                context.Response.ContentType = contentType;
                context.Response.StatusCode = 200;
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
            catch { }
        });
}
