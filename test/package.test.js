'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repositoryRoot = path.join(__dirname, '..');
const sentinelText = 'harmless package sentinel\n';
const codexFixture = 'scripts/fixtures/codex-real-probe-2026-08-06.jsonl';
const unsafe = [
  'ops/secrets.env',
  'ops/compose.env',
  'ops/postgres-password',
  'ops/backups/x.dump',
  'ops/backups/nested/x.dump',
  'ops/backups/nested/x.dump.sha256',
  'ops/backups/nested/x.dump.metadata.json',
  'ops/unexpected-file.txt',
  'bin/unexpected-file.txt',
  'scripts/unexpected-file.txt',
  'src/unexpected-file.txt',
  'server/dashboard/unexpected-file.txt',
  '.env',
  'collector-data/access-key',
  'server/collector-data/access-key',
  'backups/root.dump',
  'logs/collector.log',
  'sessions/manager.sqlite',
  'quarantine/rejected.json',
  'usage-panel.sqlite'
];
const forbiddenFixtureKeys = new Set([
  'account', 'account_id', 'cli_version', 'credits', 'cwd', 'last_token_usage',
  'limit_id', 'limit_name', 'model_context_window', 'model_provider', 'plan_type',
  'rate_limits', 'resets_at', 'session_id', 'thread_id', 'used_percent', 'window_minutes'
]);
const packedSensitivePatterns = [
  ['private key', /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/],
  ['provider API key', /\b(?:sk-(?:ant-|proj-)?|xai-|AIza)[A-Za-z0-9_-]{16,}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/],
  ['Super ZT credential', /\b(?:upd|upm|upu|upc)_[A-Za-z0-9_-]{16,}\b/],
  ['UUID-shaped identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ['literal session identifier', /"(?:session_id|thread_id)"\s*:\s*"[^"]+"/],
  ['literal account plan', /"plan_type"\s*:\s*"[^"]+"/],
  ['literal JavaScript account plan', /\bplanType\s*:\s*['"][^'"]+['"]/],
  ['literal reset timestamp', /"resets_at"\s*:\s*\d+/],
  ['literal JavaScript reset timestamp', /\bresetsAt\s*:\s*\d{9,}/],
  ['literal account window', /"(?:window_minutes|used_percent)"\s*:\s*\d+/],
  ['literal JavaScript account window', /\b(?:windowMinutes|usedPercent)\s*:\s*\d+/],
  ['non-empty packed device credential', /"deviceCredential"\s*:\s*"[^"]+"/],
  ['non-empty packed API key', /"apiKey"\s*:\s*"[^"]+"/]
];
const packedInfrastructurePatterns = [
  ['VPS host name', /\bsrv\d{6,}\b/i],
  ['agent workspace path', /\/opt\/[^/\s]+\/workspaces\//],
  ['private service subdomain', /\b(?:admin|buzz|internal|staging)\.super-zt\.com\b/i]
];
const forbiddenCustomerBehaviors = [
  ['speed-test download', /speed\.cloudflare\.com|\/api\/speedtest/],
  ['dead speed-test UI', /run speedtest|no speedtest yet|id=["']runspeed["']/i],
  ['child process execution', /require\(['"]child_process['"]\)|\bexecFile\s*\(|\bspawn\s*\(/],
  ['dormant machine telemetry', /\bnvidia-smi\b|\/proc\/net\/dev|\bfunction\s+(?:collectSystem|gpuStats|netStats|readByteCounters|cpuPercent|pingArgs)\b/]
];

function resolveRoot() { return path.resolve(process.env.PACKAGE_TEST_ROOT || repositoryRoot); }
function stateDirectory() {
  assert.ok(process.env.PACKAGE_TEST_STATE, 'PACKAGE_TEST_STATE is required');
  return path.resolve(process.env.PACKAGE_TEST_STATE);
}
function statePath() { return path.join(stateDirectory(), 'ownership.json'); }
function target(root, relative) {
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(root + path.sep), 'unsafe package-test target: ' + relative);
  return resolved;
}
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function sameIdentity(stat, owned) {
  return String(stat.dev) === owned.dev && String(stat.ino) === owned.ino;
}
function newState(root) { return { root, files: [], directories: [] }; }
function readState(root) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    assert.strictEqual(state.root, root, 'ownership state belongs to a different root');
    return state;
  } catch (err) {
    if (err.code === 'ENOENT') return newState(root);
    throw err;
  }
}
function saveState(state) {
  fs.mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  const temporary = path.join(stateDirectory(), 'ownership.tmp');
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, statePath());
}

function ensureParents(root, filename, state) {
  const missing = [];
  let current = path.dirname(filename);
  while (current !== root) {
    const relative = path.relative(root, current);
    assert.ok(relative && !relative.startsWith('..'), 'parent escaped package-test root');
    try {
      const stat = fs.lstatSync(current);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), relative + ' is not a safe directory');
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      missing.push(current);
      current = path.dirname(current);
    }
  }
  for (const directory of missing.reverse()) {
    fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    state.directories.push({ relative: path.relative(root, directory), ...identity(stat) });
    saveState(state);
  }
}

function createSentinel(root, relative, state) {
  const filename = target(root, relative);
  ensureParents(root, filename, state);
  let descriptor;
  let openedIdentity;
  try {
    descriptor = fs.openSync(filename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    openedIdentity = identity(fs.fstatSync(descriptor));
    fs.writeFileSync(descriptor, sentinelText);
    fs.fsyncSync(descriptor);
  } catch (err) {
    if (descriptor !== undefined) {
      try {
        const stat = fs.lstatSync(filename);
        if (sameIdentity(stat, openedIdentity)) fs.unlinkSync(filename);
      } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') err.cleanupError = cleanupError; }
    }
    throw err;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const stat = fs.lstatSync(filename);
  state.files.push({ relative, ...identity(stat) });
  saveState(state);
}

function cleanupOwned(root, suppliedState) {
  const state = suppliedState || readState(root);
  for (const owned of [...state.files].reverse()) {
    const filename = target(root, owned.relative);
    try {
      const stat = fs.lstatSync(filename);
      if (stat.isFile() && sameIdentity(stat, owned)) fs.unlinkSync(filename);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  for (const owned of [...state.directories].reverse()) {
    const directory = target(root, owned.relative);
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isDirectory() && sameIdentity(stat, owned)) fs.rmdirSync(directory);
    } catch (err) { if (!['ENOENT', 'ENOTEMPTY'].includes(err.code)) throw err; }
  }
  try { fs.unlinkSync(statePath()); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function setup(options = {}) {
  const root = resolveRoot();
  const state = readState(root);
  let created = state.files.length;
  const handlers = {};
  const handleSignal = (code) => () => {
    try { cleanupOwned(root, state); } finally { process.exit(code); }
  };
  handlers.SIGHUP = handleSignal(129);
  handlers.SIGINT = handleSignal(130);
  handlers.SIGTERM = handleSignal(143);
  for (const [signal, handler] of Object.entries(handlers)) process.once(signal, handler);
  const removeSignalHandlers = () => {
    for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
  };
  try {
    for (const relative of unsafe) {
      createSentinel(root, relative, state);
      created++;
      if (options.failAfter === created) throw new Error('simulated partial setup failure');
      if (options.pauseAfter === created) {
        fs.writeFileSync(options.pauseFile, String(process.pid), { flag: 'wx', mode: 0o600 });
        setInterval(() => {}, 1000);
        return;
      }
    }
    removeSignalHandlers();
  } catch (err) {
    removeSignalHandlers();
    cleanupOwned(root, state);
    throw err;
  }
}

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function snapshot(filename) {
  const stat = fs.lstatSync(filename);
  const mode = (stat.mode & 0o7777).toString(8).padStart(4, '0');
  if (stat.isFile()) return { type: 'file', mode, hash: sha256(fs.readFileSync(filename)) };
  assert.ok(stat.isDirectory(), 'unsupported pre-existing test path');
  const rows = [];
  function visit(directory, prefix) {
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const childStat = fs.lstatSync(child);
      const childMode = (childStat.mode & 0o7777).toString(8).padStart(4, '0');
      const relative = path.join(prefix, name);
      if (childStat.isDirectory()) { rows.push(['d', relative, childMode]); visit(child, relative); }
      else rows.push(['f', relative, childMode, sha256(fs.readFileSync(child))]);
    }
  }
  visit(filename, '');
  return { type: 'directory', mode, hash: sha256(Buffer.from(JSON.stringify(rows))) };
}
function writePreExisting(root, relative, content, mode) {
  const filename = target(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content, { mode });
  fs.chmodSync(filename, mode);
  return filename;
}

function preservationCase(name, prepare) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-preserve-root-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-preserve-state-'));
  const previousRoot = process.env.PACKAGE_TEST_ROOT;
  const previousState = process.env.PACKAGE_TEST_STATE;
  process.env.PACKAGE_TEST_ROOT = root;
  process.env.PACKAGE_TEST_STATE = state;
  try {
    const paths = prepare(root);
    const before = paths.map((filename) => snapshot(filename));
    assert.throws(() => setup(), /EEXIST|safe directory/);
    const after = paths.map((filename) => snapshot(filename));
    assert.deepStrictEqual(after, before);
    for (let index = 0; index < paths.length; index++) {
      console.log('  preserved ' + name + ': ' + path.relative(root, paths[index]) +
        ' before_mode=' + before[index].mode + ' after_mode=' + after[index].mode +
        ' before_sha256=' + before[index].hash + ' after_sha256=' + after[index].hash);
    }
    console.log('  ok   ' + name);
  } finally {
    if (previousRoot === undefined) delete process.env.PACKAGE_TEST_ROOT;
    else process.env.PACKAGE_TEST_ROOT = previousRoot;
    if (previousState === undefined) delete process.env.PACKAGE_TEST_STATE;
    else process.env.PACKAGE_TEST_STATE = previousState;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
}

function selfTest() {
  preservationCase('pre-existing ops secret survives byte-for-byte and mode-for-mode', (root) => [
    writePreExisting(root, 'ops/secrets.env', 'REAL_OPERATOR_SECRET=keep-me\n', 0o640)
  ]);
  preservationCase('pre-existing nested backup facts survive transactional failure', (root) => [
    writePreExisting(root, 'ops/backups/nested/x.dump', 'durable dump\n', 0o600),
    writePreExisting(root, 'ops/backups/nested/x.dump.sha256', 'durable checksum\n', 0o640),
    writePreExisting(root, 'ops/backups/nested/x.dump.metadata.json', '{"keep":true}\n', 0o644)
  ]);
  preservationCase('pre-existing unexpected directory and file in another tree survive', (root) => {
    const directory = target(root, 'scripts/unexpected-file.txt');
    fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
    fs.chmodSync(directory, 0o750);
    writePreExisting(root, 'scripts/unexpected-file.txt/keep.txt', 'keep directory child\n', 0o640);
    const file = writePreExisting(root, 'src/unexpected-file.txt', 'keep source sentinel\n', 0o600);
    return [directory, file];
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-partial-root-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-partial-state-'));
  const previousRoot = process.env.PACKAGE_TEST_ROOT;
  const previousState = process.env.PACKAGE_TEST_STATE;
  process.env.PACKAGE_TEST_ROOT = root;
  process.env.PACKAGE_TEST_STATE = state;
  try {
    assert.throws(() => setup({ failAfter: 6 }), /simulated partial setup failure/);
    assert.ok(unsafe.every((relative) => !fs.existsSync(target(root, relative))));
    console.log('  partial_failure_created=6 owned_paths_remaining=0');
    console.log('  ok   partial setup failure removes only invocation-owned paths');
  } finally {
    if (previousRoot === undefined) delete process.env.PACKAGE_TEST_ROOT;
    else process.env.PACKAGE_TEST_ROOT = previousRoot;
    if (previousState === undefined) delete process.env.PACKAGE_TEST_STATE;
    else process.env.PACKAGE_TEST_STATE = previousState;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
}

function archiveName(inventoryFile) {
  const result = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))[0];
  assert.ok(result && /^[A-Za-z0-9._-]+\.tgz$/.test(result.filename), 'unsafe package archive name');
  process.stdout.write(result.filename);
}
function walkFiles(directory, prefix = '') {
  const files = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const filename = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) files.push(...walkFiles(filename, relative));
    else if (stat.isFile()) files.push(relative);
  }
  return files;
}
function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}
function inspectCodexFixture(filename) {
  const text = fs.readFileSync(filename, 'utf8').trim();
  const rows = text.split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(rows.length, 2, 'Codex fixture must contain only model context and token counters');
  assert.deepStrictEqual(rows[0], {
    timestamp: '2099-01-01T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' }
  });
  assert.deepStrictEqual(rows[1], {
    timestamp: '2099-01-01T00:00:01.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: {
        input_tokens: 19608, cached_input_tokens: 3712, cache_write_input_tokens: 0,
        output_tokens: 15, reasoning_output_tokens: 0
      } }
    }
  });
  const found = [...new Set(collectKeys(rows).filter((key) => forbiddenFixtureKeys.has(key)))];
  assert.deepStrictEqual(found, [], 'Codex fixture contains private metadata keys: ' + found.join(', '));
  assert.ok(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text),
    'Codex fixture contains a session-shaped identifier');
}
function publicIpv4Literals(text) {
  const matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  return [...new Set(matches.filter((value) => {
    const octets = value.split('.').map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return false;
    if (value === '0.0.0.0' || value === '1.1.1.1') return false;
    if (octets[0] === 10 || octets[0] === 127) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
    return true;
  }))];
}
function inspect(inventoryFile, extractedRoot) {
  const result = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))[0];
  assert.ok(result && Array.isArray(result.files), 'npm pack returned no package inventory');
  const summaryEntries = result.files.map((file) => file.path).sort();
  const archiveEntries = walkFiles(extractedRoot).sort();
  const packageJson = JSON.parse(fs.readFileSync(target(resolveRoot(), 'package.json'), 'utf8'));
  const expected = [...new Set(['package.json', ...packageJson.files])].sort();

  assert.ok(packageJson.files.every((entry) => !entry.endsWith('/') && !/[?*\[\]]/.test(entry)));
  assert.deepStrictEqual(summaryEntries, expected);
  assert.deepStrictEqual(archiveEntries, expected);
  console.log('  ok   real archive and npm summary equal the exact file allowlist');

  inspectCodexFixture(target(resolveRoot(), codexFixture));
  inspectCodexFixture(path.join(extractedRoot, codexFixture));
  console.log('  ok   source and packed Codex fixture contain only synthetic model/token evidence');

  for (const intended of [
    'bin/usage-panel.js', 'config.example.json', 'dashboard.html', 'refresher.js',
    'src/core/runtime-config.js', 'src/sync/client.js'
  ]) assert.ok(archiveEntries.includes(intended), intended + ' missing from archive');
  assert.ok(archiveEntries.every((entry) => !entry.startsWith('server/')), 'server code entered customer archive');
  assert.ok(archiveEntries.every((entry) => !entry.startsWith('ops/')), 'operations code entered customer archive');
  assert.ok(archiveEntries.every((entry) => !entry.startsWith('backups/')), 'backup entered customer archive');
  assert.ok(!archiveEntries.includes('Dockerfile'), 'deployment Dockerfile entered customer archive');
  assert.ok(!archiveEntries.includes('config.json'), 'mutable runtime config entered customer archive');
  assert.ok(!/server[\\/]collector|DATABASE_URL/.test(
    fs.readFileSync(path.join(extractedRoot, 'bin/usage-panel.js'), 'utf8')
  ), 'customer command exposes collector administration');
  console.log('  ok   customer archive is client-only and excludes server, migration, backup and deployment paths');

  for (const relative of unsafe) assert.ok(!archiveEntries.includes(relative), relative + ' entered archive');
  let sentinelMatches = 0;
  for (const relative of archiveEntries) {
    const content = fs.readFileSync(path.join(extractedRoot, relative));
    if (content.includes(Buffer.from(sentinelText))) sentinelMatches++;
  }
  assert.strictEqual(sentinelMatches, 0);
  console.log('  ok   operator secrets, backups, state, and unexpected files stay excluded by path and content');

  const packedConfig = JSON.parse(fs.readFileSync(path.join(extractedRoot, 'config.example.json'), 'utf8'));
  assert.strictEqual(packedConfig.openrouter.apiKey, '', 'packed config contains an API key');
  assert.strictEqual(packedConfig.sync.deviceCredential, '', 'packed config contains a device credential');
  assert.strictEqual(packedConfig.sync.deviceId, '', 'packed config contains a real device identifier');
  const sensitiveMatches = [];
  for (const relative of archiveEntries) {
    const text = fs.readFileSync(path.join(extractedRoot, relative), 'utf8');
    for (const [name, pattern] of packedSensitivePatterns) {
      if (pattern.test(text)) sensitiveMatches.push(relative + ': ' + name);
    }
    for (const [name, pattern] of packedInfrastructurePatterns) {
      if (pattern.test(text)) sensitiveMatches.push(relative + ': ' + name);
    }
    for (const [name, pattern] of forbiddenCustomerBehaviors) {
      if (pattern.test(text)) sensitiveMatches.push(relative + ': ' + name);
    }
    if (publicIpv4Literals(text).length) {
      sensitiveMatches.push(relative + ': public infrastructure address');
    }
  }
  assert.deepStrictEqual(sensitiveMatches, [],
    'packed archive contains sensitive metadata: ' + sensitiveMatches.join(', '));
  assert.deepStrictEqual(packageJson.dependencies || {}, {}, 'customer archive has production server dependencies');
  for (const script of ['collector', 'db:migrate', 'company:bootstrap', 'user:create', 'retention', 'test:stack']) {
    assert.ok(!packageJson.scripts[script], 'customer package exposes server operation: ' + script);
  }
  const releaseGate = fs.readFileSync(target(resolveRoot(), 'scripts/release-safety.sh'), 'utf8');
  const workflow = fs.readFileSync(target(resolveRoot(), '.github/workflows/release-safety.yml'), 'utf8');
  for (const command of ['npm test', 'npm run accuracy:codex', 'npm audit --audit-level=low',
    'npm audit --prefix server --omit=dev --audit-level=low', 'npm pack --json --ignore-scripts']) {
    assert.ok(releaseGate.includes(command), 'release gate omits ' + command);
  }
  assert.match(workflow, /sh scripts\/release-safety\.sh/);
  assert.ok(!archiveEntries.includes('scripts/release-safety.sh'), 'repository release gate entered customer archive');
  assert.ok(archiveEntries.every((entry) => !entry.startsWith('.github/')), 'GitHub workflow entered customer archive');
  console.log('  ok   repository-only release gate runs tests, audits, accuracy and actual archive inspection');
  console.log('  ok   packed archive contains no account metadata, credentials, keys, or private infrastructure');
  console.log('  package entries: ' + archiveEntries.length);
  console.log('  unsafe sentinel path matches: 0/' + unsafe.length);
  console.log('  unsafe sentinel content matches: 0');
  console.log('  sensitive metadata/secret/private infrastructure matches: 0');
}

function verifyClean() {
  const root = resolveRoot();
  assert.ok(unsafe.every((relative) => !fs.existsSync(target(root, relative))));
  const label = process.env.PACKAGE_TEST_VERIFY_LABEL || 'interruption';
  const status = process.env.PACKAGE_TEST_VERIFY_STATUS || '143';
  console.log('  ' + label + '_exit=' + status + ' owned_paths_remaining=0');
  console.log('  ok   ' + label + ' cleanup removes only invocation-owned paths');
}

const command = process.argv[2];
if (command === 'setup') setup({
  pauseAfter: Number(process.env.PACKAGE_TEST_PAUSE_AFTER || 0),
  pauseFile: process.env.PACKAGE_TEST_PAUSE_FILE
});
else if (command === 'cleanup') cleanupOwned(resolveRoot());
else if (command === 'selftest') selfTest();
else if (command === 'archive-name') archiveName(process.argv[3]);
else if (command === 'inspect') inspect(process.argv[3], process.argv[4]);
else if (command === 'verify-clean') verifyClean();
else throw new Error('unknown package test command');
