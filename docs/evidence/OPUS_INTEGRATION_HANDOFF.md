# Integrating Claude Opus `app/**` into Grok integration base

This branch is the single recovery integration base. Grok owns installer,
packaging, workflows, docs, and non-`app/**` integration evidence. Claude Opus
owns only `app/**`.

## Base identity (before Opus merge)

Recorded at branch creation / Grok handoff commit; replace with final Grok
commit hash when merging Opus:

- Branch: `grok-vps/v103-integration-base`
- Start parent: `9ff02f89a59e79ee0113f538c521d0d98b64a1b7` (PR 5 head)

## Exact merge steps

```bash
# On a clean worktree of grok-vps/v103-integration-base:
git fetch origin
git checkout grok-vps/v103-integration-base
git merge --no-ff <opus-commit-sha> -m "Integrate Opus app/** into v1.0.3 recovery base"

# Verify Opus touched only app/**
git diff --name-only <grok-head-before-merge>..HEAD | grep -v '^app/' && echo FAIL_NON_APP || echo only_app_or_empty
```

If Opus’s branch rebased onto something other than this base, prefer:

```bash
git checkout -b integrate-opus grok-vps/v103-integration-base
git checkout <opus-commit-sha> -- app/
git commit -m "Integrate Opus app/** tree at <opus-commit-sha>"
```

Do **not** push to Opus’s branch. Do **not** merge PR 5 as-is.

## App statuses the smoke test expects after Opus

| Status | Meaning |
|--------|---------|
| `WEBVIEW_READY` | Embedded dashboard ready in-window |
| `WEBVIEW2_MISSING` | WebView2 runtime absent; plain-English recovery, not “reinstall” |
| `SERVER_FAILED` | Local server child failed |
| `PORT_IN_USE` | Port 8899 occupied |
| `PAYLOAD_MISSING` | Required client payload missing/corrupt |
| `ENROLLMENT_FAILED` | Enrollment dialog/path failed (not labeled as browser failure) |

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
