# Usage Panel 1.0.3 for Windows

This candidate replaces the hidden v1.0.2 script-and-browser launch chain with
a real Windows application window. The window appears immediately, owns its
taskbar entry, starts the bundled local server, and renders the dashboard inside
the app. If a server child exits or the embedded browser cannot load, the same
window remains visible with a plain-English failure message instead of silently
disappearing.

The installer clears stale shutdown markers during upgrades. Desktop and Start
Menu **Usage Panel** shortcuts target `UsagePanel.exe` directly; the separate
**Link this computer** action still passes the one-time code to the enrollment
client through standard input and opens exactly one app window after success.

Launcher diagnostics are bounded to 100 fixed status lines under the current
user's local application data. They contain no usernames, local paths, account
details, one-time codes, credentials, prompts, tokens, or exception text.

This package is the consumer installer for Windows 10 and Windows 11. It
includes a private Node.js runtime and a self-contained Windows application;
customers do not install Node.js or .NET and do not use a terminal.

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
runtime, and shortcuts are removed. Per-user enrollment and local usage data are
retained so an accidental uninstall does not destroy customer data.

## Signing status

Version 1.0.3 is **unsigned**. Super ZT has not purchased a Windows code-signing
certificate. Windows SmartScreen may show an **Unknown publisher** warning. The
published SHA-256 file lets customers verify the downloaded bytes. No
certificate purchase was made for this candidate.
