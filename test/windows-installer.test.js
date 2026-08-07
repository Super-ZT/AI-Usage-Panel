'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
function read(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

(async () => {
  const required = [
    'installer/UsagePanel.nsi',
    'installer/build-windows.ps1',
    'installer/RELEASE_NOTES.md',
    'enroll-panel.ps1',
    'uninstall-helper.ps1',
    '.github/workflows/windows-installer.yml'
  ];
  for (const relative of required) {
    assert.ok(fs.existsSync(path.join(root, relative)), relative + ' must exist');
  }

  const nsi = read('installer/UsagePanel.nsi');
  assert.match(nsi, /RequestExecutionLevel user/);
  assert.match(nsi, /UsagePanel-Setup-\$\{VERSION\}\.exe/);
  assert.match(nsi, /CreateShortCut "\$DESKTOP\\Usage Panel\.lnk"/);
  assert.match(nsi, /CreateDirectory "\$SMPROGRAMS\\Usage Panel"/);
  assert.match(nsi, /WriteUninstaller/);
  assert.match(nsi, /Section "Uninstall"/);

  const build = read('installer/build-windows.ps1');
  assert.match(build, /\$NodeVersion = "24\.19\.0"/);
  assert.match(build, /node-v\$NodeVersion-win-x64\.zip/);
  assert.match(build, /57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73/);
  assert.match(build, /Get-FileHash[^\n]+SHA256/i);
  assert.match(build, /makensis/i);

  const start = read('start-panel.cmd');
  const bundled = start.indexOf('node\\node.exe');
  const pathLookup = start.indexOf('where node');
  assert.ok(bundled >= 0 && pathLookup >= 0 && bundled < pathLookup,
    'bundled Node must be preferred over a machine-wide Node installation');

  const opener = read('open-panel.cmd');
  assert.match(opener, /enrollment\.json/);
  assert.match(opener, /enroll-panel\.ps1/);
  assert.match(opener, /Program Files\\Microsoft\\Edge/);

  const enrollUi = read('enroll-panel.ps1');
  assert.match(enrollUi, /https:\/\/super-zt\.com\/api\/usage-panel/);
  assert.match(enrollUi, /RedirectStandardInput\s*=\s*\$true/);
  assert.doesNotMatch(enrollUi, /--allow-insecure/);
  assert.doesNotMatch(enrollUi, /Write-(?:Host|Output).*code/i);

  const workflow = read('.github/workflows/windows-installer.yml');
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /UsagePanel-Setup-/);

  const sync = require('../src/sync/client');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.strictEqual(req.url, '/api/v1/enroll');
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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('  ok   Windows installer bundles Node, creates shortcuts, uninstalls, and enrolls over fixed HTTPS');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
