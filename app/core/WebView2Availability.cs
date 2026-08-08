namespace UsagePanel.Core;

/// <summary>
/// Whether the embedded browser runtime is really present.
///
/// This answer is a pure function of what the WebView2 loader reports and
/// nothing else. It deliberately reads no environment variable, no file, and
/// no setting: a build that could be told "the runtime is missing" by anything
/// other than the runtime itself would let a stray variable strand every
/// customer on an "install WebView2" screen that reinstalling cannot clear,
/// and would let a green test prove only that the error screen renders.
/// </summary>
public static class WebView2Availability
{
    /// <param name="reportInstalledVersion">
    /// The loader's own query — normally
    /// <c>CoreWebView2Environment.GetAvailableBrowserVersionString</c>. A null
    /// or blank answer, or a throw, means the runtime is not usable here.
    /// </param>
    public static bool IsPresent(Func<string?> reportInstalledVersion)
    {
        if (reportInstalledVersion is null) return false;

        try
        {
            return !string.IsNullOrWhiteSpace(reportInstalledVersion());
        }
        catch
        {
            // WebView2RuntimeNotFoundException, a missing loader DLL, or any
            // other failure to answer all mean the same thing to the customer.
            return false;
        }
    }
}
