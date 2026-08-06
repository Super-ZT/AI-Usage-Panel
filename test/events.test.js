'use strict';

/**
 * Tests for the append-only usage event store.
 * Runs against a throwaway data directory. Run: node test/events.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Point the store at a scratch directory before it is first required.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-test-'));
process.env.USAGE_PANEL_DATA_DIR = scratch;

let events = require('../src/core/events');
const { identity } = require('../src/core/device');

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

/** @param {object} [over] */
function sampleEvent(over) {
  return Object.assign({
    device_id: 'device-a',
    harness: 'opencode',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4.8',
    ts: '2026-08-02T10:00:00.000Z',
    tokens: { in: 100, out: 20, cache_read: 900, cache_write: 0, reasoning: 0 },
    source: 'proxy',
    request_id: 'req-1'
  }, over || {});
}

(async () => {
  console.log('usage event store tests\n');
  console.log('storage');

  await test('appending writes an event and returns it', async () => {
    const r = events.append(sampleEvent());
    assert.strictEqual(r.written, true);
    assert.ok(r.event.event_id, 'event_id assigned');
    await events.flush();
    const all = events.read({ from: '2026-08-02', to: '2026-08-02' });
    assert.ok(all.some((e) => e.event_id === r.event.event_id), 'event reached disk');
  });

  await test('the same event appended twice is stored once', async () => {
    const first = events.append(sampleEvent({ request_id: 'req-dup' }));
    const second = events.append(sampleEvent({ request_id: 'req-dup' }));
    assert.strictEqual(first.written, true);
    assert.strictEqual(second.written, false);
    assert.strictEqual(second.reason, 'duplicate');
    assert.strictEqual(first.event.event_id, second.event.event_id);
  });

  await test('idempotency survives a restart (ids reloaded from disk)', async () => {
    events.append(sampleEvent({ request_id: 'req-restart' }));
    await events.flush();
    delete require.cache[require.resolve('../src/core/events')];
    const reloaded = require('../src/core/events');
    const again = reloaded.append(sampleEvent({ request_id: 'req-restart' }));
    assert.strictEqual(again.written, false, 'must not re-write after restart');
    events = reloaded;
  });

  await test('distinct calls are not merged', () => {
    const a = events.append(sampleEvent({ request_id: 'req-a', ts: '2026-08-02T11:00:00.000Z' }));
    const b = events.append(sampleEvent({ request_id: 'req-b', ts: '2026-08-02T11:00:00.000Z' }));
    assert.strictEqual(a.written, true);
    assert.strictEqual(b.written, true);
    assert.notStrictEqual(a.event.event_id, b.event.event_id);
  });

  await test('events without a request id dedupe on their natural key', () => {
    const base = sampleEvent({ request_id: null, ts: '2026-08-02T12:00:00.000Z' });
    assert.strictEqual(events.append(base).written, true);
    assert.strictEqual(events.append(base).written, false);
  });

  await test('same request id from different providers is not merged (regression: C3)', () => {
    // Self-hosted runtimes reuse short request ids; without the provider in the
    // key the second event would be dropped as a duplicate.
    const a = events.append(sampleEvent({ request_id: 'chatcmpl-1', provider: 'ollama', ts: '2026-08-02T14:00:00.000Z' }));
    const b = events.append(sampleEvent({ request_id: 'chatcmpl-1', provider: 'lmstudio', ts: '2026-08-02T14:00:00.000Z' }));
    assert.strictEqual(a.written, true);
    assert.strictEqual(b.written, true, 'distinct providers must produce distinct ids');
    assert.notStrictEqual(a.event.event_id, b.event.event_id);
  });

  await test('reasoning tokens participate in the natural key (regression: M6)', () => {
    const base = { request_id: null, ts: '2026-08-02T15:00:00.000Z' };
    const a = events.append(sampleEvent(Object.assign({ tokens: { in: 1, out: 1, reasoning: 0 } }, base)));
    const b = events.append(sampleEvent(Object.assign({ tokens: { in: 1, out: 1, reasoning: 500 } }, base)));
    assert.strictEqual(a.written, true);
    assert.strictEqual(b.written, true, 'differing reasoning tokens must not collide');
  });

  await test('an invalid timestamp does not throw (regression: H4)', () => {
    const r = events.append(sampleEvent({ ts: 'not-a-date', request_id: 'req-badts' }));
    assert.strictEqual(r.written, true, 'import of third-party logs must not crash on one bad row');
  });

  await test('zero-token events are rejected rather than stored', () => {
    const r = events.append(sampleEvent({
      request_id: 'req-empty',
      tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0 }
    }));
    assert.strictEqual(r.written, false);
    assert.strictEqual(r.reason, 'no token usage reported');
  });

  await test('malformed input is refused without throwing', () => {
    assert.strictEqual(events.append(null).written, false);
    assert.strictEqual(events.append({}).written, false);
  });

  await test('token aliases from the proxy are normalised', () => {
    const r = events.append({
      device_id: 'd', harness: 'pi', provider: 'openai', model: 'm',
      ts: '2026-08-02T13:00:00.000Z', request_id: 'req-alias',
      tokens: {
        in: 5, out: 6, cacheRead: 7, cacheWrite: 8,
        cacheWrite5m: 3, cacheWrite1h: 5
      }
    });
    assert.strictEqual(r.event.tokens.cache_read, 7);
    assert.strictEqual(r.event.tokens.cache_write, 8);
    assert.strictEqual(r.event.tokens.cache_write_5m, 3);
    assert.strictEqual(r.event.tokens.cache_write_1h, 5);
  });

  await test('unknown token categories survive normalization and affect natural identity', () => {
    const base = {
      device_id: 'd', harness: 'codex', provider: 'openai', model: 'gpt-5.6-sol',
      ts: '2026-08-02T13:30:00.000Z', request_id: null,
      tokens: { in: 5, out: 1, missing: ['cache_write', 'cache_write'] }
    };
    const partial = events.append(base);
    const exact = events.append(Object.assign({}, base, { tokens: { in: 5, out: 1 } }));
    assert.deepStrictEqual(partial.event.tokens.missing, ['cache_write']);
    assert.strictEqual(partial.written, true);
    assert.strictEqual(exact.written, true);
    assert.strictEqual(exact.event.event_id, '9a5b6d924617536f8d5ec074e779d142',
      'adding evidence metadata must not change legacy exact-event identities');
    assert.notStrictEqual(partial.event.event_id, exact.event.event_id);
  });

  console.log('\nreading and aggregation');

  await test('duplicate lines on disk are counted once (regression: C2)', async () => {
    await events.flush();
    const file = path.join(events.eventsDir(), '2026-08-02.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // Simulate a second process (or a collector merge) re-appending a row.
    fs.appendFileSync(file, lines[0] + '\n', 'utf8');

    const all = events.read({ from: '2026-08-02', to: '2026-08-02' });
    const target = JSON.parse(lines[0]).event_id;
    const occurrences = all.filter((e) => e.event_id === target).length;
    assert.strictEqual(occurrences, 1, 'read() must deduplicate by event_id');

    const rolled = events.rollup(all);
    assert.ok(Object.keys(rolled).length > 0, 'rollup still produces buckets');
  });

  await test('ids written with different spacing still dedupe (regression: M5)', async () => {
    await events.flush();
    const day = '2026-08-04';
    const file = path.join(events.eventsDir(), day + '.jsonl');
    // A collector may serialise with spaces or different key order.
    fs.writeFileSync(file, '{ "harness": "x", "event_id": "spaced-id-1", "tokens": {"in":1} }\n', 'utf8');

    delete require.cache[require.resolve('../src/core/events')];
    const reloaded = require('../src/core/events');
    const r = reloaded.append({
      event_id: 'spaced-id-1', device_id: 'd', harness: 'x', provider: 'p',
      ts: day + 'T10:00:00.000Z', tokens: { in: 1, out: 1 }
    });
    assert.strictEqual(r.written, false, 'must recognise a differently-formatted id');
    events = reloaded;
  });

  await test('read returns everything written in range', async () => {
    await events.flush();
    const all = events.read({ from: '2026-08-01', to: '2026-08-05' });
    assert.ok(all.length >= 5, 'expected several events, got ' + all.length);
  });

  await test('read excludes days outside the range', async () => {
    events.append(sampleEvent({ request_id: 'req-old', ts: '2026-01-05T10:00:00.000Z' }));
    await events.flush();
    const inRange = events.read({ from: '2026-08-01', to: '2026-08-05' });
    assert.ok(!inRange.some((e) => e.request_id === 'req-old'));
    const wide = events.read({ from: '2026-01-01', to: '2026-08-05' });
    assert.ok(wide.some((e) => e.request_id === 'req-old'));
  });

  await test('rollup groups by day, harness and model and sums tokens', () => {
    const rolled = events.rollup([
      sampleEvent({ tokens: { in: 10, out: 1, cache_read: 100 } }),
      sampleEvent({ tokens: { in: 20, out: 2, cache_read: 200 } }),
      sampleEvent({ harness: 'pi', model: 'gpt-5.6-sol', tokens: { in: 5, out: 5 } })
    ]);
    const day = Object.keys(rolled)[0];
    const oc = rolled[day]['opencode']['anthropic/claude-opus-4.8'];
    assert.strictEqual(oc.tokens.in, 30);
    assert.strictEqual(oc.tokens.cache_read, 300);
    assert.strictEqual(oc.calls, 2);
    assert.strictEqual(rolled[day]['pi']['gpt-5.6-sol'].tokens.out, 5);
  });

  await test('rollup buckets by local day, not UTC', () => {
    const rolled = events.rollup([sampleEvent({ ts: '2026-08-02T23:30:00.000Z' })]);
    const d = new Date('2026-08-02T23:30:00.000Z');
    const expected = d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
    assert.ok(rolled[expected], 'bucket must follow the local calendar day');
  });

  await test('unparseable lines are skipped rather than aborting a read', async () => {
    await events.flush();
    fs.appendFileSync(path.join(events.eventsDir(), '2026-08-02.jsonl'), '{ this is not json\n', 'utf8');
    const all = events.read({ from: '2026-08-02', to: '2026-08-02' });
    assert.ok(all.length > 0, 'valid rows still returned alongside a torn line');
  });

  console.log('\nwrite queue');

  await test('writes are asynchronous but flush is deterministic', async () => {
    // Keep this distinct from the invalid-timestamp fallback, which is written
    // under the real current UTC day.
    const day = '2099-01-01';
    events.append({
      device_id: 'd', harness: 'queue-test', provider: 'p', model: 'm',
      ts: day + 'T01:00:00.000Z', request_id: 'q1', tokens: { in: 1, out: 1 }
    });
    await events.flush();
    const all = events.read({ from: day, to: day });
    assert.strictEqual(all.length, 1, 'flush must guarantee durability');
  });

  await test('many rapid appends all land exactly once', async () => {
    const day = '2099-01-02';
    for (let i = 0; i < 200; i++) {
      events.append({
        device_id: 'd', harness: 'burst', provider: 'p', model: 'm',
        ts: day + 'T02:00:00.000Z', request_id: 'burst-' + i, tokens: { in: 1, out: 1 }
      });
    }
    await events.flush();
    const all = events.read({ from: day, to: day });
    assert.strictEqual(all.length, 200, 'expected 200 rows, got ' + all.length);
    assert.strictEqual(new Set(all.map((e) => e.event_id)).size, 200, 'no id collisions');
  });

  console.log('\ndevice identity');

  await test('device identity is stable across calls', () => {
    const a = identity();
    const b = identity();
    assert.strictEqual(a.id, b.id);
    assert.ok(a.label && !a.label.includes(' '), 'label is slugified');
  });

  console.log('\nretention');

  await test('prune removes only files older than the window', async () => {
    await events.flush();
    const before = events.read({ from: '2026-01-01', to: '2026-12-31' }).length;
    const removed = events.prune(1);
    assert.ok(removed >= 1, 'expected at least one old file removed');
    const after = events.read({ from: '2026-01-01', to: '2026-12-31' }).length;
    assert.ok(after < before, 'pruned events no longer readable');
  });

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('\n' + f.name + '\n' + (f.err && f.err.stack));
    process.exit(1);
  }
})();
