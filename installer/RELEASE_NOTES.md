# Usage Panel 1.0.3 for Windows (x64)

This candidate replaces the hidden v1.0.2 script-and-browser launch chain with
a real Windows application window. The window appears immediately, owns its
taskbar entry, starts the bundled local server, and renders the dashboard inside
the app. If a server child exits or the embedded browser cannot load, the same
window remains visible with a plain-English failure message instead of silently
disappearing.

## Supported Windows platforms

- **Supported:** Windows 10 x64 and Windows 11 x64
- **Not supported:** Windows 10 on ARM (cannot run this win-x64 package)
- Windows 11 on ARM is not a first-class support claim for 1.0.3

The packaged host is a self-contained .NET 8 **win-x64** `UsagePanel.exe`.
Customers do not install .NET or Node.js.

## Upgrade from public v1.0.2

Install 1.0.3 **directly over** the failed 1.0.2 install. Do not uninstall first.

The installer:

1. Stops only known Usage Panel processes scoped to the existing install folder
   (`UsagePanel.exe`, that install’s bundled `node.exe` running the refresher,
   and obsolete `wscript`/`cmd` launchers for this install).
2. Removes obsolete launchers: `open-panel.cmd`, `open-panel.vbs`,
   `start-hidden.vbs`.
3. Clears a stale `.usage-panel-stop` marker.
4. Refuses a half-upgrade when the install folder is locked.
5. Recreates Desktop and Start Menu shortcuts targeting `UsagePanel.exe`
   through the signed-in user’s shell folders (including OneDrive Desktop).
6. Preserves deliberately safe enrollment state under
   `%APPDATA%\usage-panel\enrollment.json` (outside the install folder).

## Microsoft Edge WebView2

The local dashboard is shown with Microsoft Edge WebView2. The installer
packages Microsoft’s official small **Evergreen Bootstrapper** with a pinned
checksum (`MicrosoftEdgeWebview2Setup.exe` +
`webview2-bootstrapper.provenance.txt`) and runs it only when the runtime is
missing. If the runtime is still unavailable, the app must show a visible
recovery message and record `WEBVIEW2_MISSING` rather than a generic reinstall
hint. Official docs: https://developer.microsoft.com/microsoft-edge/webview2/

## Close behavior

Closing the Usage Panel window fully exits all Usage Panel-owned processes.
There is no hidden tray or background collector mode in 1.0.3. Monitoring and
upload resume the next time the customer opens Usage Panel.

## Installer and shortcuts

Desktop and Start Menu **Usage Panel** shortcuts target `UsagePanel.exe`
directly. The separate **Link this computer** action still passes the one-time
code to the enrollment client through standard input and opens exactly one app
window after success.

Launcher diagnostics are bounded to fixed status lines under the current user’s
local application data. They contain no usernames, local paths, account
details, one-time codes, credentials, prompts, tokens, raw exception text, or
unintended server/test/ops content.

## Install

1. Download `UsagePanel-Setup-1.0.3.exe`.
2. Double-click it and follow the installer.
3. Open **Usage Panel** from the Desktop or Start Menu.
4. Paste the one-time link code from <https://super-zt.com/portal/usage-panel> when prompted.

Enrollment is sent only to the fixed HTTPS Super ZT endpoint. The code and
returned device credential are never written to logs or shown in command
arguments.

## Uninstall

Open **Settings → Apps → Installed apps → Usage Panel → Uninstall**, or choose
**Uninstall Usage Panel** from its Start Menu folder. The application, bundled
runtime, shortcuts, and running Usage Panel-owned processes are removed.
Per-user enrollment and local usage data under the user profile are retained so
an accidental uninstall does not destroy customer data.

## Signing status

Version 1.0.3 is **unsigned**. Super ZT has not purchased a Windows code-signing
certificate. Windows SmartScreen may show an **Unknown publisher** warning. The
published SHA-256 file lets customers verify the downloaded bytes. No
certificate purchase was made for this candidate.
