using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

// UsagePanel.exe — native WebView2 host for the local usage dashboard.
// Boots the Node server if it's not running, then renders http://localhost:8899
// in its own window with its own taskbar identity.
static class Program
{
    [DllImport("shell32.dll", SetLastError = true)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

    const string Url = "http://localhost:8899";

    static bool PortUp(int timeoutMs)
    {
        try
        {
            using (var c = new TcpClient())
            {
                var r = c.BeginConnect("127.0.0.1", 8899, null, null);
                return r.AsyncWaitHandle.WaitOne(timeoutMs) && c.Connected;
            }
        }
        catch { return false; }
    }

    static void EnsureServer(string baseDir)
    {
        if (PortUp(400)) return;
        var vbs = Path.Combine(baseDir, "start-hidden.vbs");
        if (File.Exists(vbs))
        {
            var psi = new ProcessStartInfo("wscript.exe", "\"" + vbs + "\"");
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }
        for (int i = 0; i < 40 && !PortUp(250); i++) Thread.Sleep(250);
    }

    [STAThread]
    static void Main()
    {
        SetCurrentProcessExplicitAppUserModelID("UsagePanel.Local");
        SetProcessDPIAware();
        Application.EnableVisualStyles();

        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string baseDir = Path.GetFullPath(Path.Combine(appDir, ".."));
        EnsureServer(baseDir);

        var form = new Form();
        form.Text = "USAGE_PANEL";
        form.BackColor = Color.FromArgb(10, 11, 11);
        Rectangle working = Screen.PrimaryScreen.WorkingArea;
        form.ClientSize = new Size(Math.Min(1520, working.Width), Math.Min(940, working.Height));
        form.StartPosition = FormStartPosition.CenterScreen;
        string ico = Path.Combine(baseDir, "usage-panel.ico");
        if (File.Exists(ico)) form.Icon = new Icon(ico);

        var wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        wv.DefaultBackgroundColor = Color.FromArgb(10, 11, 11);
        wv.CreationProperties = new CoreWebView2CreationProperties();
        wv.CreationProperties.UserDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "UsagePanel");
        form.Controls.Add(wv);

        // dark title bar
        form.HandleCreated += delegate
        {
            int dark = 1;
            DwmSetWindowAttribute(form.Handle, 20, ref dark, 4);
        };

        // if the server was mid-boot and the first load failed, retry until it's up
        wv.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                var t = new System.Windows.Forms.Timer();
                t.Interval = 1500;
                t.Tick += delegate { t.Stop(); t.Dispose(); try { wv.Reload(); } catch { } };
                t.Start();
            }
        };
        wv.Source = new Uri(Url);

        Application.Run(form);
    }
}
