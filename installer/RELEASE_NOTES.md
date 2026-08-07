# Usage Panel 1.0.1 for Windows

This hotfix makes the Windows app's enrollment and event-upload requests match
the Super ZT website's URLs and data contract, including the website's Windows
platform name. Version 1.0.0 installed successfully but could not link a
computer because its request did not match that contract.

This package is the consumer installer for Windows 10 and Windows 11.

## What it installs

- Usage Panel desktop application
- A private bundled Node.js runtime; customers do not install Node.js
- Desktop and Start Menu shortcuts
- A Start Menu link for entering a one-time Super ZT portal code
- A normal Windows uninstaller

## Install

1. Download `UsagePanel-Setup-1.0.1.exe`.
2. Double-click it and follow the installer.
3. Open **Usage Panel** from the Desktop or Start Menu.
4. Paste the one-time link code from <https://super-zt.com/portal/usage-panel> when prompted.

Enrollment is sent only to the fixed HTTPS Super ZT endpoint. The code and returned device credential are never written to logs or shown in command arguments.

## Uninstall

Open **Settings → Apps → Installed apps → Usage Panel → Uninstall**, or choose **Uninstall Usage Panel** from its Start Menu folder.

Uninstalling removes the application and shortcuts. It intentionally leaves per-user enrollment and local usage data under `%APPDATA%\usage-panel` so an accidental uninstall does not destroy customer data.

## Signing status

Version 1.0.1 is **unsigned**. Super ZT has not purchased a Windows code-signing certificate. Windows SmartScreen may show an “Unknown publisher” warning. The published SHA-256 file lets customers verify the downloaded bytes. No certificate purchase was made for this release.
