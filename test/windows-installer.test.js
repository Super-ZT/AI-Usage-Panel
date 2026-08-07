'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

(async () => {
  const required = [
    'app/UsagePanel.csproj',
    'app/host.cs',
    'installer/UsagePanel.nsi',
    'installer/build-windows.ps1',
    'installer/windows-smoke.ps1',
    'installer/RELEASE_NOTES.md',
    'enroll-panel.ps1',
    'open-panel-after-link.ps1',
    'uninstall-helper.ps1',
    '.github/workflows/windows-installer.yml'
  ];
  for (const relative of required) {
    assert.ok(fs.existsSync(path.join(root, relative)), relative + ' must exist');
  }

  const nsi = read('installer/UsagePanel.nsi');
  assert.match(nsi, /!define VERSION "1\.0\.3"/);
  assert.match(nsi, /RequestExecutionLevel user/);
  assert.match(nsi, /UsagePanel-Setup-\$\{VERSION\}\.exe/);
  assert.ok(nsi.indexOf('SetShellVarContext current') < nsi.indexOf('CreateShortCut "$DESKTOP\\Usage Panel.lnk"'),
    'shortcuts must resolve through the current user shell folders');
  assert.match(nsi, /CreateShortCut "\$DESKTOP\\Usage Panel\.lnk"[^\n]+UsagePanel\.exe/);
  assert.match(nsi, /CreateShortCut "\$SMPROGRAMS\\Usage Panel\\Usage Panel\.lnk"[^\n]+UsagePanel\.exe/);
  assert.doesNotMatch(nsi, /Usage Panel\.lnk"[^\n]+wscript\.exe/i,
    'the customer launcher must be a visible application, not a hidden script');
  assert.match(nsi, /Delete "\$INSTDIR\\\.usage-panel-stop"/,
    'install and upgrade must clear any stale shutdown marker');
  assert.match(nsi, /CreateDirectory "\$SMPROGRAMS\\Usage Panel"/);
  assert.match(nsi, /Link this computer\.lnk[^\n]+enroll-panel\.ps1[^\n]+-OpenPanelAfterLink/);
  assert.match(nsi, /WriteUninstaller/);
  assert.match(nsi, /Section "Uninstall"/);

  const build = read('installer/build-windows.ps1');
  assert.match(build, /\$NodeVersion = "24\.19\.0"/);
  assert.match(build, /node-v\$NodeVersion-win-x64\.zip/);
  assert.match(build, /57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73/);
  assert.match(build, /Get-FileHash[^\n]+SHA256/i);
  assert.match(build, /makensis/i);
  assert.match(build, /dotnet[\s\S]+publish[\s\S]+UsagePanel\.csproj/i);
  assert.match(build, /UsagePanel\.exe/);

  const host = read('app/host.cs');
  assert.match(host, /http:\/\/127\.0\.0\.1:8899/,
    'the application must use the same explicit IPv4 address the server binds');
  assert.match(host, /Application\.Run\(/,
    'the application must own a visible top-level window');
  assert.match(host, /MainWindowTitle/,
    'the application must expose a stable title for visible-window verification');
  assert.match(host, /launcher\.log/);
  assert.match(host, /SERVER_FAILED/);
  assert.match(host, /MessageBox|failureLabel/i,
    'startup failure must remain visible in plain English');
  assert.doesNotMatch(host, /WriteAllText\([^\n]+(?:UserName|UserProfile|code|credential|token)/i,
    'launcher diagnostics must not record identities or secrets');

  const start = read('start-panel.cmd');
  const bundled = start.indexOf('node\\node.exe');
  const pathLookup = start.indexOf('where node');
  assert.ok(bundled >= 0 && pathLookup >= 0 && bundled < pathLookup,
    'bundled Node must be preferred over a machine-wide Node installation');
  assert.match(start, /STOP_FILE=.*\.usage-panel-stop/);
  assert.match(start, /cd \/d "%TEMP%"/);
  assert.doesNotMatch(start, /cd \/d "%~dp0"/,
    'the long-lived refresher launcher must not lock the install directory');
  assert.ok((start.match(/if exist "%STOP_FILE%" exit \/b 0/g) || []).length >= 2,
    'the restart loop must stop both before launch and after Node is terminated');

  const uninstallHelper = read('uninstall-helper.ps1');
  assert.match(uninstallHelper, /\.usage-panel-stop/);
  assert.match(uninstallHelper, /Stop-Process/);
  assert.match(uninstallHelper, /start-panel\.cmd/);
  assert.match(uninstallHelper, /Get-Process -Name "UsagePanel"/);
  assert.match(uninstallHelper, /Wait-Process -Timeout 5/);
  assert.doesNotMatch(uninstallHelper, /open-panel\.cmd/);
  assert.match(uninstallHelper, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(uninstallHelper, /Stop-Process -Id \$_\.ProcessId -Force/);
  assert.match(uninstallHelper, /Start-Sleep -Milliseconds 100/);

  const enrollUi = read('enroll-panel.ps1');
  assert.match(enrollUi, /param\([\s\S]*\[switch\]\$OpenPanelAfterLink[\s\S]*\)/);
  assert.match(enrollUi, /https:\/\/super-zt\.com\/api\/usage-panel/);
  assert.match(enrollUi, /RedirectStandardInput\s*=\s*\$true/);
  assert.match(enrollUi, /Linked\. Opening Usage Panel/);
  assert.doesNotMatch(enrollUi, /MessageBox\]::Show\("This computer is linked/,
    'successful enrollment must not pause behind a blocking completion dialog');
  assert.match(enrollUi, /if \(\$OpenPanelAfterLink\)[\s\S]*open-panel-after-link\.ps1/);
  assert.strictEqual((enrollUi.match(/open-panel-after-link\.ps1/g) || []).length, 1,
    'direct linking must hand off to the panel exactly once');
  assert.doesNotMatch(enrollUi, /--allow-insecure/);
  assert.doesNotMatch(enrollUi, /Write-(?:Host|Output).*code/i);

  const handoff = read('open-panel-after-link.ps1');
  assert.match(handoff, /UsagePanel\.exe/);
  assert.doesNotMatch(handoff, /open-panel\.vbs|wscript\.exe/i);
  assert.match(handoff, /Start-Process/);
  assert.match(handoff, /GetTempPath/);
  assert.doesNotMatch(handoff, /-WorkingDirectory \$AppRoot/);
  assert.doesNotMatch(handoff, /credential|one-time|--code/i);

  const workflow = read('.github/workflows/windows-installer.yml');
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /UsagePanel-Setup-1\.0\.3/);
  assert.match(workflow, /UsagePanel-Setup-1\.0\.2\.exe/,
    'Windows CI must exercise the exact failed public baseline');
  assert.match(workflow, /\.\/installer\/windows-smoke\.ps1/);

  const windowsSmoke = read('installer/windows-smoke.ps1');
  assert.match(windowsSmoke, /GetFolderPath\([^\n]*DesktopDirectory/);
  assert.match(windowsSmoke, /GetFolderPath\([^\n]*Programs/);
  assert.match(windowsSmoke, /CreateShortcut/);
  assert.match(windowsSmoke, /TargetPath/);
  assert.match(windowsSmoke, /Arguments/);
  assert.match(windowsSmoke, /open-panel-after-link\.ps1/);
  assert.match(windowsSmoke, /api\/sync/);
  assert.match(windowsSmoke, /MainWindowHandle/);
  assert.match(windowsSmoke, /IsWindowVisible/);
  assert.match(windowsSmoke, /Usage Panel - Could not open/);
  assert.match(windowsSmoke, /baseline_v102_silent_launcher_reproduced/);
  assert.match(windowsSmoke, /visible_window_ok/);
  assert.match(windowsSmoke, /function Wait-PathRemoved/);
  assert.match(windowsSmoke, /Wait-PathRemoved -Path \$InstallDir/);
  assert.match(windowsSmoke, /panel_visible_launch_diagnostics_shortcuts_uninstall_ok/);
  assert.match(windowsSmoke, /uninstall_residual=/);
  assert.doesNotMatch(windowsSmoke, /\$Path:/,
    'PowerShell variables immediately before a colon must use braced syntax');

  const packageJson = JSON.parse(read('package.json'));
  assert.strictEqual(packageJson.version, '1.0.3');

  const sync = require('../src/sync/client');
  const syncSource = read('src/sync/client.js');
  assert.strictEqual(
    sync.collectorUrl('https://super-zt.com/api/usage-panel', 'enroll').href,
    'https://super-zt.com/api/usage-panel/v1/enroll',
    'the Windows endpoint must match the mounted Super ZT enrollment route'
  );
  assert.strictEqual(
    sync.collectorUrl('https://super-zt.com/api/usage-panel', 'events').href,
    'https://super-zt.com/api/usage-panel/v1/events',
    'event uploads must use the same mounted Super ZT route'
  );
  assert.strictEqual(
    sync.collectorUrl('https://super-zt.com/api/usage-panel', 'fleet').href,
    'https://super-zt.com/api/usage-panel/v1/fleet',
    'fleet requests must use the same mounted Super ZT route'
  );
  assert.strictEqual(
    sync.collectorUrl('https://collector.example.com', 'enroll').href,
    'https://collector.example.com/api/v1/enroll',
    'standalone collector endpoints must keep their existing API path'
  );
  assert.strictEqual(
    sync.collectorUrl('https://collector.example.com/mounted', 'events').href,
    'https://collector.example.com/mounted/v1/events',
    'mounted collectors append v1 directly to their configured path'
  );
  assert.strictEqual(sync.collectorPlatform('win32'), 'windows');
  assert.strictEqual(sync.collectorPlatform('darwin'), 'macos');
  assert.strictEqual(sync.collectorPlatform('linux'), 'linux');
  assert.doesNotMatch(syncSource, /api\/usage-panel\/api\/v1\//);
  assert.deepStrictEqual(sync.portalEvent({
    event_id: 'portal-event-1',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-4.5',
    source: 'local-jsonl',
    ts: '2026-08-07T00:00:00.000Z',
    tokens: {
      in: 10, out: 2, cache_read: 3, cache_write: 7,
      cache_write_5m: 2, cache_write_1h: 5, cache_write_unresolved: 0
    }
  }), {
    eventId: 'portal-event-1',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-4.5',
    source: 'local-jsonl',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWrite5mTokens: 2,
    cacheWrite1hTokens: 5,
    cacheWriteUnresolvedTokens: 0,
    occurredAt: '2026-08-07T00:00:00.000Z'
  });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.strictEqual(req.url, '/api/v1/enroll');
      if (body.code === 'expired-code') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (body.code === 'service-error-code') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unavailable' }));
        return;
      }
      assert.strictEqual(body.code, 'one-time-code');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        deviceId: '11111111-1111-4111-8111-111111111111',
        credential: 'server-shape-credential'
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await sync.enroll({
      endpoint: 'http://127.0.0.1:' + server.address().port,
      code: 'one-time-code',
      label: 'Windows PC'
    });
    assert.strictEqual(result.deviceCredential, 'server-shape-credential');
    assert.strictEqual(result.deviceId, '11111111-1111-4111-8111-111111111111');
    await assert.rejects(sync.enroll({
      endpoint: 'http://127.0.0.1:' + server.address().port,
      code: 'expired-code',
      label: 'Windows PC'
    }), /^Error: invalid or expired enrollment code$/);
    await assert.rejects(sync.enroll({
      endpoint: 'http://127.0.0.1:' + server.address().port,
      code: 'service-error-code',
      label: 'Windows PC'
    }), /^Error: enrollment failed \(HTTP 503\)$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('  ok   Windows installer opens the panel after both link paths and resolves real user shortcuts');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
