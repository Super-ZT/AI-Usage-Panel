'use strict';

/**
 * Production-shaped harness detection tests.
 *
 * These exercise the real detector against real on-disk footprints. Nothing is
 * stubbed: empty folders must not look installed, marker homes must, and no
 * Usage Panel environment variable can invent a detection.
 *
 * Run: node test/detect.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-detect-'));
// Isolate default ~/<harness> homes so this machine's real installs cannot
// make a test fixture look installed via fall-through.
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;

// Clear harness-owned home env vars that would point at real installs.
const HARNESS_HOME_ENV = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'GEMINI_CONFIG_DIR', 'HERMES_HOME'
];
const previousHarnessEnv = {};
for (const name of HARNESS_HOME_ENV) {
  previousHarnessEnv[name] = process.env[name];
  delete process.env[name];
}

const detect = require('../src/detect');
const registry = require('../src/detect/registry');

let passed = 0;
const failures = [];

/** @param {string} name @param {() => void|Promise<void>} fn */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n       ' + (err && err.message));
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function write(file, body) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, body, 'utf8');
}

function restoreEnv() {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  for (const name of HARNESS_HOME_ENV) {
    if (previousHarnessEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousHarnessEnv[name];
  }
}

/** Hostile names that must never fabricate harness detection. */
const HOSTILE_DETECT_VARS = [
  'USAGE_PANEL_FORCE_DETECT',
  'USAGE_PANEL_FAKE_HARNESS',
  'USAGE_PANEL_SMOKE_FORCE_DETECT',
  'USAGE_PANEL_TEST',
  'USAGE_PANEL_SMOKE',
  'FORCE_HARNESS',
  'MOCK_DETECT'
];

(async () => {
  console.log('harness detection tests\n');

  await test('empty marker-less home is not accepted as a data home', () => {
    const emptyHome = path.join(scratch, 'empty-kimi');
    mkdirp(emptyHome);
    // Direct unit proof: resolveHome must reject empty marker-less dirs.
    const resolved = detect.resolveHome(registry.byId('kimi'), emptyHome);
    assert.strictEqual(resolved, null, 'bare mkdir must not spoof a marker-less harness home');
    const result = detect.scan({ homes: { kimi: emptyHome } });
    const row = result.detected.find((h) => h.id === 'kimi');
    if (row) {
      // Binary on PATH may still detect the tool; the empty override must not
      // be reported as its home.
      assert.notStrictEqual(row.homePath, emptyHome);
    } else {
      assert.ok(result.missing.some((h) => h.id === 'kimi'));
    }
  });

  await test('marker-less home with real content is detected and hasData', () => {
    const home = path.join(scratch, 'kimi-used');
    write(path.join(home, 'config.json'), '{"ok":true}\n');
    const resolved = detect.resolveHome(registry.byId('kimi'), home);
    assert.ok(resolved);
    assert.strictEqual(resolved.path, home);
    const result = detect.scan({ homes: { kimi: home } });
    const row = result.detected.find((h) => h.id === 'kimi');
    assert.ok(row, 'content-bearing home must count as installed');
    assert.strictEqual(row.installed, true);
    assert.strictEqual(row.hasData, true);
    assert.strictEqual(row.homePath, home);
    assert.strictEqual(row.homeSource, 'config');
  });

  await test('claude home without projects marker is rejected by resolveHome', () => {
    const home = path.join(scratch, 'claude-empty');
    mkdirp(home);
    write(path.join(home, 'noise.txt'), 'not a marker\n');
    assert.strictEqual(detect.resolveHome(registry.byId('claude-code'), home), null,
      'claude requires the projects marker, not just any file');
    const result = detect.scan({ homes: { 'claude-code': home } });
    const row = result.detected.find((h) => h.id === 'claude-code');
    if (row) assert.notStrictEqual(row.homePath, home);
  });

  await test('claude home with projects marker is detected', () => {
    const home = path.join(scratch, 'claude-real');
    mkdirp(path.join(home, 'projects'));
    write(path.join(home, 'projects', 'session.jsonl'), '{}\n');
    const result = detect.scan({ homes: { 'claude-code': home } });
    const row = result.detected.find((h) => h.id === 'claude-code');
    assert.ok(row);
    assert.strictEqual(row.installed, true);
    assert.strictEqual(row.hasData, true);
    assert.strictEqual(row.homePath, home);
    assert.strictEqual(row.homeSource, 'config');
  });

  await test('codex and grok require their registry markers', () => {
    const codexBare = path.join(scratch, 'codex-bare');
    const grokBare = path.join(scratch, 'grok-bare');
    mkdirp(codexBare);
    mkdirp(grokBare);
    write(path.join(codexBare, 'readme.txt'), 'no sessions dir\n');
    write(path.join(grokBare, 'readme.txt'), 'no auth.json\n');
    assert.strictEqual(detect.resolveHome(registry.byId('codex'), codexBare), null);
    assert.strictEqual(detect.resolveHome(registry.byId('grok-build'), grokBare), null);

    mkdirp(path.join(codexBare, 'sessions'));
    write(path.join(codexBare, 'sessions', 'rollout-1.jsonl'), '{}\n');
    write(path.join(grokBare, 'auth.json'), '{"ok":true}\n');
    const result = detect.scan({ homes: { codex: codexBare, 'grok-build': grokBare } });
    assert.ok(result.detected.some((h) => h.id === 'codex' && h.homePath === codexBare && h.hasData));
    assert.ok(result.detected.some((h) => h.id === 'grok-build' && h.homePath === grokBare && h.hasData));
  });

  await test('installed-without-data is distinct from hasData for marker homes', () => {
    const home = path.join(scratch, 'claude-marker-only');
    mkdirp(path.join(home, 'projects')); // marker present, no files inside
    const result = detect.scan({ homes: { 'claude-code': home } });
    const row = result.detected.find((h) => h.id === 'claude-code');
    assert.ok(row, 'marker alone is enough to count as installed');
    assert.strictEqual(row.installed, true);
    assert.strictEqual(row.homePath, home);
    // shallowCount only tallies files, so an empty marker directory means
    // installed=true and hasData=false — the two must not be collapsed.
    assert.strictEqual(row.hasData, false);
  });

  await test('no hostile Usage Panel env var can fabricate a harness detection', () => {
    const previous = {};
    for (const name of HOSTILE_DETECT_VARS) {
      previous[name] = process.env[name];
      process.env[name] = 'claude-code,codex,grok-build,kimi,cursor';
    }
    try {
      const empty = path.join(scratch, 'hostile-empty');
      mkdirp(empty);
      assert.strictEqual(detect.resolveHome(registry.byId('kimi'), empty), null);
      assert.strictEqual(detect.resolveHome(registry.byId('cursor'), empty), null);
      const result = detect.scan({ homes: { kimi: empty, cursor: empty } });
      const kimi = result.detected.find((h) => h.id === 'kimi');
      const cursor = result.detected.find((h) => h.id === 'cursor');
      if (kimi) assert.notStrictEqual(kimi.homePath, empty);
      if (cursor) assert.notStrictEqual(cursor.homePath, empty);
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'detect', 'index.js'), 'utf8');
      for (const name of HOSTILE_DETECT_VARS) {
        assert.ok(!source.includes(name), 'detector must not mention ' + name);
      }
    } finally {
      for (const name of HOSTILE_DETECT_VARS) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  await test('registry coverage: every harness is either detected or missing, never both', () => {
    const result = detect.scan({ homes: {} });
    const detectedIds = new Set(result.detected.map((h) => h.id));
    const missingIds = new Set(result.missing.map((h) => h.id));
    for (const sig of registry.all()) {
      const inDetected = detectedIds.has(sig.id);
      const inMissing = missingIds.has(sig.id);
      assert.ok(inDetected !== inMissing, sig.id + ' must appear in exactly one list');
    }
  });

  await test('scan source never reads USAGE_PANEL_* force/fake switches', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'detect', 'index.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', 'src', 'detect', 'registry.js'), 'utf8');
    assert.doesNotMatch(source, /USAGE_PANEL_(FORCE|FAKE|SMOKE|TEST)/);
    assert.doesNotMatch(source, /FORCE_HARNESS|MOCK_DETECT|SPOOF/);
  });

  console.log('');
  restoreEnv();
  if (failures.length) {
    console.error(failures.length + ' failed, ' + passed + ' passed');
    process.exit(1);
  }
  console.log(passed + ' passed');
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }
})().catch((err) => {
  restoreEnv();
  console.error(err.stack || err.message);
  process.exit(1);
});
