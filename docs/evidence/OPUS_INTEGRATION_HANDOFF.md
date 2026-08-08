# Integrating Claude Opus `app/**` into Grok integration base

This branch is the single recovery integration base. Grok owns installer,
packaging, workflows, docs, and non-`app/**` integration evidence. Claude Opus
owns only `app/**`.

## Base identity

- Branch: `grok-vps/v103-integration-base`
- Start parent: `9ff02f89a59e79ee0113f538c521d0d98b64a1b7` (PR 5 head)
- Grok integration base (pre-Opus): `280c96c3329717b8772cf9f2bca92f4b54111a78`
- Opus app/** head integrated: `7c0990fac0d630fbbe95a8120cf8218949bacc08` (tree `5dbf7204…`)
- Handoff source: `/tmp/usage-panel-opus-handoff/` (SHA256SUMS verified)

## Exact merge steps (already applied)

```bash
# On a clean worktree of grok-vps/v103-integration-base:
git fetch /tmp/usage-panel-opus-handoff/opus-native-app-hardening.bundle \
  opus/native-app-hardening:opus/native-app-hardening
git merge --no-ff 7c0990fac0d630fbbe95a8120cf8218949bacc08 \
  -m "Integrate Opus app/** into v1.0.3 recovery base"

# Verify Opus touched only app/**
git diff --name-only 280c96c..HEAD | grep -v '^app/' && echo FAIL_NON_APP || echo only_app_or_empty
```

Do **not** push to Opus’s branch. Do **not** merge PR 5 as-is.

## App statuses the smoke test expects after Opus

| Status | Meaning |
|--------|---------|
| `DASHBOARD_VISIBLE` | Real window surface shows the dashboard (strict replacement for the old self-reported ready claim) |
| `DASHBOARD_HIDDEN` | Window present but dashboard surface not visible |
| `WEBVIEW2_MISSING` | WebView2 runtime absent; plain-English recovery, not “reinstall” |
| `SERVER_FAILED` | Local server child failed |
| `PORT_IN_USE` | Port 8899 occupied |
| `PAYLOAD_MISSING` | Required client payload missing/corrupt |
| `ENROLLMENT_FAILED` | Enrollment dialog/path failed (not labeled as browser failure) |

Allowlist source of truth: `app/core/StatusCodes.cs` (not comments in `host.cs`).

Diagnostics: only `ISO8601_TIMESTAMP STATUS_CODE` lines; no usernames, paths,
codes, tokens, prompts, credentials, secrets, or raw exception text.

## Product close behavior (locked)

Close of the main window must fully exit all Usage Panel-owned processes
(host + bundled node refresher). No tray/background mode. Monitoring resumes
on next launch. Documented in README and release notes.

Second launch must restore a minimized window (`SW_RESTORE`) then focus it.

## Verification after integrate

```powershell
./installer/build-windows.ps1 -Version 1.0.3
# Download public v1.0.2 Setup.exe, checksum-pin 991800b7d5e20374a6014254fb45d2ba9b6e2ea44b1115e5b6c05bc19875598e
./installer/windows-smoke.ps1 -Version 1.0.3 -BaselineInstaller <path-to-v1.0.2> -RequireAppAssertions
```

Also run repository `npm test`, package boundary checks, and both dependency
audits at low severity with zero unresolved findings.
