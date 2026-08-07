'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-client-release-'));
const configDir = path.join(scratch, 'config');
const dataDir = path.join(scratch, 'data');
const archiveDir = path.join(scratch, 'archive');
const extractDir = path.join(scratch, 'extracted');
const credentialSentinel = 'upd_SENTINEL_CREDENTIAL_DO_NOT_PACKAGE_20260806';
const deviceSentinel = '11111111-1111-4111-8111-111111111111';
const sessionSentinel = 'PROVIDER_SESSION_SENTINEL_20260806';
const requestSentinel = 'PROVIDER_REQUEST_SENTINEL_20260806';
const promptSentinel = 'PRIVATE_PROMPT_SENTINEL_20260806';
const template = path.join(root, 'config.example.json');
const templateBefore = crypto.createHash('sha256').update(fs.readFileSync(template)).digest('hex');
let uploaded = null;

process.env.USAGE_PANEL_CONFIG_DIR = configDir;
process.env.USAGE_PANEL_DATA_DIR = dataDir;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, Object.assign({ cwd: root, windowsHide: true }, options));
    let stdout = ''; let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += chunk));
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => status === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(command + ' exited ' + status + ': ' + stderr)));
    if (options.input != null) child.stdin.end(options.input);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });
}

function allFiles(directory, prefix = '') {
  const files = [];
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) files.push(...allFiles(filename, relative));
    else if (stat.isFile()) files.push(relative);
  }
  return files.sort();
}

(async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const raw = await readBody(req);
      if (req.url === '/api/v1/enroll') {
        const body = JSON.parse(raw);
        assert.strictEqual(body.code, 'sentinel-one-use-code');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ deviceCredential: credentialSentinel, deviceId: deviceSentinel }));
        return;
      }
      if (req.url === '/api/v1/events') {
        uploaded = raw;
        const body = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: body.events.map((event) => event.event_id) }));
        return;
      }
      res.writeHead(404); res.end();
    } catch (_) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'test server failure' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const enrolled = await run(process.execPath, [
      'bin/usage-panel.js', 'enroll', '--endpoint', endpoint, '--code-stdin',
      '--allow-insecure', '--label', 'release-sentinel-device'
    ], {
      env: Object.assign({}, process.env, {
        USAGE_PANEL_CONFIG_DIR: configDir,
        USAGE_PANEL_DATA_DIR: dataDir
      }),
      input: 'sentinel-one-use-code\n'
    });
    assert.ok(!enrolled.stdout.includes(credentialSentinel));
    assert.ok(!enrolled.stdout.includes(deviceSentinel));
    assert.ok(!fs.existsSync(path.join(root, 'config.json')));
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(template)).digest('hex'), templateBefore);

    const enrollmentFile = path.join(dataDir, 'enrollment.json');
    const deviceFile = path.join(dataDir, 'device.json');
    assert.ok(fs.existsSync(enrollmentFile)); assert.ok(fs.existsSync(deviceFile));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(dataDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(enrollmentFile).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(deviceFile).mode & 0o777, 0o600);
    }

    const events = require('../src/core/events');
    const runtimeConfig = require('../src/core/runtime-config');
    const sync = require('../src/sync/client');
    const safeMerge = runtimeConfig.merge({}, JSON.parse('{"__proto__":{"polluted":true},"sync":{"enabled":true}}'));
    assert.strictEqual({}.polluted, undefined); assert.strictEqual(safeMerge.sync.enabled, true);
    const loadedConfig = runtimeConfig.load(root);
    assert.strictEqual(loadedConfig.sync.endpoint, endpoint);
    assert.strictEqual(loadedConfig.sync.deviceCredential, credentialSentinel);
    assert.strictEqual(loadedConfig.sync.deviceId, deviceSentinel);
    events.append({
      event_id: 'release-outbound-canary-0001',
      device_id: 'local-device-identifier',
      harness: 'codex', provider: 'openai', model: 'gpt-5.6-sol', pricing_model: 'gpt-5.6-sol',
      ts: new Date().toISOString(), tokens: { in: 17, out: 3, cache_read: 2, cache_write: 0 },
      source: 'local_log', session_id: sessionSentinel, request_id: requestSentinel,
      prompt: promptSentinel
    });
    await events.flush();
    const pushed = await sync.pushOnce(loadedConfig.sync);
    assert.strictEqual(pushed.ok, true, JSON.stringify(pushed)); assert.strictEqual(pushed.sent, 1);
    assert.ok(uploaded, 'no outbound payload captured');
    for (const forbidden of [sessionSentinel, requestSentinel, promptSentinel, 'session_id', 'request_id']) {
      assert.ok(!uploaded.includes(forbidden), 'outbound payload leaked ' + forbidden);
    }
    const outbound = JSON.parse(uploaded);
    const requiredKeys = ['event_id', 'harness', 'model', 'pricing_model', 'provider', 'source', 'tokens', 'ts'];
    const allowedKeys = requiredKeys.concat(['duration_ms', 'status']);
    assert.ok(requiredKeys.every((key) => Object.hasOwn(outbound.events[0], key)), 'outbound payload omitted a required key');
    assert.deepStrictEqual(Object.keys(outbound.events[0]).filter((key) => !allowedKeys.includes(key)), []);

    fs.mkdirSync(archiveDir); fs.mkdirSync(extractDir);
    const inventoryResult = await run('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', archiveDir
    ], { env: Object.assign({}, process.env, { npm_config_cache: path.join(scratch, 'npm-cache') }) });
    const inventory = JSON.parse(inventoryResult.stdout)[0];
    await run('tar', ['-xzf', path.join(archiveDir, inventory.filename), '-C', extractDir]);
    const packageRoot = path.join(extractDir, 'package');
    const archiveFiles = allFiles(packageRoot);
    assert.ok(archiveFiles.every((name) => !name.startsWith('server/')));
    assert.ok(archiveFiles.every((name) => !name.startsWith('ops/')));
    assert.ok(!archiveFiles.includes('Dockerfile')); assert.ok(!archiveFiles.includes('config.json'));
    const packedText = archiveFiles.map((name) => fs.readFileSync(path.join(packageRoot, name), 'utf8')).join('\n');
    for (const forbidden of [credentialSentinel, deviceSentinel, sessionSentinel, requestSentinel, promptSentinel]) {
      assert.ok(!packedText.includes(forbidden), 'actual archive contains release sentinel');
    }

    console.log('  ok   enrollment writes credential and device identity only to protected per-user storage');
    console.log('  runtime directory mode: ' + (fs.statSync(dataDir).mode & 0o777).toString(8));
    console.log('  enrollment file mode: ' + (fs.statSync(enrollmentFile).mode & 0o777).toString(8));
    console.log('  device file mode: ' + (fs.statSync(deviceFile).mode & 0o777).toString(8));
    console.log('  ok   real outbound payload omits provider session/request identifiers and prompt canary');
    console.log('  outbound event keys: ' + Object.keys(outbound.events[0]).sort().join(','));
    console.log('  ok   post-enrollment actual archive contains 0/5 sentinel values');
    console.log('  post-enrollment package entries: ' + archiveFiles.length);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
