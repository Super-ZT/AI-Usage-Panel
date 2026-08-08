'use strict';

/**
 * Tests for the two failure modes that silently stopped a linked PC reporting.
 *
 *   1. An expired device credential was retried forever with nothing on screen.
 *   2. A PC whose clock ran fast had its usage refused and then destroyed,
 *      because every refusal was treated as permanent.
 *
 * Runs against a throwaway data directory and a loopback collector, so no
 * database and no network are needed. Run: node test/sync-transport.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-sync-'));
process.env.USAGE_PANEL_DATA_DIR = scratch;

const events = require('../src/core/events');
const outbox = require('../src/sync/outbox');
const client = require('../src/sync/client');

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

/**
 * A collector whose answer each test controls, recording every request so a
 * test can assert that no request was made at all.
 */
function startCollector(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* not json */ }
      received.push({ url: req.url, auth: req.headers.authorization, body });
      const answer = handler(body, received.length);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.json === undefined ? {} : answer.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        received,
        // The portal contract is selected by this path shape.
        endpoint: 'http://127.0.0.1:' + port + '/api/usage-panel',
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/**
 * Start a test with a clean link state and nothing pending. The event store is
 * append-only and shared by the whole file, so events written by earlier tests
 * are marked as already delivered rather than deleted — that leaves each test
 * looking at only the events it appends itself.
 */
async function resetState() {
  await events.flush();
  const existing = events.read({ from: '1970-01-01' }).map((e) => e.event_id).filter(Boolean);
  outbox.saveCursor({
    sent: existing, rejected: [], deferred: {},
    link: { status: 'ok', fingerprint: null, since: null, message: null, attempts: 0, retryAfter: null },
    lastSyncAt: null, lastError: null, sentTotal: 0, rejectedTotal: 0, deferredTotal: 0
  });
}

let eventSeq = 0;
/**
 * Append one real usage event, flush it to disk, and return its stable id.
 * @param {number} [ageDays=0] how long ago the usage happened
 */
async function appendEvent(ageDays) {
  eventSeq++;
  const age = (Number(ageDays) || 0) * 24 * 3600 * 1000;
  const result = events.append({
    device_id: 'device-under-test',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    ts: new Date(Date.now() - age - 60000 - eventSeq * 1000).toISOString(),
    tokens: { in: 1000 + eventSeq, out: 500, cache_read: 0, cache_write: 0 },
    source: 'local_log'
  });
  assert.ok(result.written, 'test event was written');
  await events.flush();
  return result.event.event_id;
}

const CREDENTIAL_A = 'a'.repeat(64);
const CREDENTIAL_B = 'b'.repeat(64);

/** @param {string} endpoint @param {string} credential */
function config(endpoint, credential) {
  return { endpoint, deviceCredential: credential, deviceId: 'device-under-test', batchSize: 50 };
}

(async () => {
  console.log('sync transport');

  // ---- an expired link -----------------------------------------------------

  await test('a refused credential is not sent a second time, and says what to do', async () => {
    await resetState();
    await appendEvent();
    const collector = await startCollector(() => ({ status: 401, json: { error: 'Authentication required' } }));
    try {
      const first = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(collector.received.length, 1, 'the first push reaches the collector');
      assert.equal(first.ok, false);
      assert.equal(first.relinkRequired, true, 'the result says the PC must be linked again');
      assert.match(first.message, /link/i, 'the message tells the customer about linking');
      assert.match(first.message, /portal\/usage-panel/, 'the message names where to get a new code');

      const second = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(collector.received.length, 1, 'the dead credential is NOT sent again');
      assert.equal(second.relinkRequired, true);
      assert.ok(second.nextAttemptAt, 'the client says when it will try again');
    } finally { await collector.close(); }
  });

  await test('the panel reports "needs linking again" instead of looking idle', async () => {
    const state = outbox.status();
    assert.equal(state.relinkRequired, true, 'status carries the re-link state');
    assert.ok(state.relinkSince, 'status says since when');
    assert.ok(state.nextAttemptAt, 'status says when it retries');
    assert.ok(state.pendingTotal + state.waitingTotal > 0, 'the unsent usage is still counted');
  });

  await test('the refusal is a pause, not a permanent lock', async () => {
    const cursor = outbox.loadCursor();
    assert.equal(cursor.link.status, 'rejected');
    const wait = Date.parse(cursor.link.retryAfter) - Date.now();
    assert.ok(wait > 0 && wait <= 6 * 3600 * 1000, 'a retry is scheduled within six hours, got ' + wait);
  });

  await test('linking the PC again clears the refusal by itself', async () => {
    const collector = await startCollector((body) => ({
      status: 200,
      json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) }
    }));
    try {
      // Same device, new credential: this is exactly what re-linking produces.
      const result = await client.push(config(collector.endpoint, CREDENTIAL_B));
      assert.equal(collector.received.length, 1, 'the new credential is used straight away');
      assert.equal(result.ok, true);
      assert.ok(result.sent > 0, 'the usage held on the PC is delivered, not lost');
      assert.equal(outbox.status().relinkRequired, false, 'the re-link state is cleared');
    } finally { await collector.close(); }
  });

  await test('a delivery clears a refusal even on the same credential', async () => {
    await resetState();
    await appendEvent();
    let answer401 = true;
    const collector = await startCollector((body) => (answer401
      ? { status: 401, json: { error: 'Authentication required' } }
      : { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } }));
    try {
      await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(outbox.status().relinkRequired, true);
      // The collector recovers; time passes to the scheduled retry.
      answer401 = false;
      const cursor = outbox.loadCursor();
      cursor.link.retryAfter = new Date(Date.now() - 1000).toISOString();
      outbox.saveCursor(cursor);
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.ok(result.sent > 0, 'the retry delivers');
      assert.equal(outbox.status().relinkRequired, false, 'a transient refusal does not strand the PC');
    } finally { await collector.close(); }
  });

  // ---- a clock that runs fast ---------------------------------------------

  await test('usage refused for a bad clock is kept, not destroyed', async () => {
    await resetState();
    const id = await appendEvent();
    const collector = await startCollector((body) => ({
      status: 200,
      json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'rejected', reason: 'timestamp_out_of_range' })) }
    }));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.ok, true);
      assert.equal(result.deferred || 0, 1, 'the event is held back');
      assert.equal(result.rejected || 0, 0, 'it is NOT counted as permanently rejected');
      const cursor = outbox.loadCursor();
      assert.ok(!cursor.rejected.includes(id), 'the event is not quarantined forever');
      assert.ok(cursor.deferred[id], 'the event is recorded for a later attempt');
      assert.equal(cursor.deferred[id].reason, 'timestamp_out_of_range');
      assert.equal(outbox.status().waitingTotal, 1, 'the panel can say it is waiting, not lost');
    } finally { await collector.close(); }
  });

  await test('a held-back event is not retried until its retry time', async () => {
    const collector = await startCollector(() => ({ status: 200, json: { outcomes: [] } }));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(collector.received.length, 0, 'nothing is sent while the event is held back');
      assert.equal(result.sent, 0);
    } finally { await collector.close(); }
  });

  await test('once the clock is corrected the same usage arrives, exactly once', async () => {
    // Time passes: bring the scheduled retry into the past.
    const cursor = outbox.loadCursor();
    for (const entry of Object.values(cursor.deferred)) {
      entry.until = new Date(Date.now() - 1000).toISOString();
    }
    outbox.saveCursor(cursor);

    const accepted = [];
    const collector = await startCollector((body) => {
      for (const e of body.events) accepted.push(e.eventId);
      return { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } };
    });
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1, 'the previously refused event is delivered');
      assert.equal(accepted.length, 1, 'the collector saw it once, not twice');
      assert.equal(new Set(accepted).size, 1, 'no duplicate event id was sent');
      const after = outbox.loadCursor();
      assert.equal(Object.keys(after.deferred).length, 0, 'nothing is left held back');
      assert.equal(outbox.status().waitingTotal, 0);
    } finally { await collector.close(); }
  });

  await test('an event refused for a reason that cannot change stays rejected', async () => {
    await resetState();
    const id = await appendEvent();
    const collector = await startCollector((body) => ({
      status: 200,
      json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'rejected', reason: 'schema_invalid' })) }
    }));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.rejected, 1, 'counted as permanently rejected');
      assert.equal(result.deferred || 0, 0, 'not scheduled for a retry');
      assert.ok(outbox.loadCursor().rejected.includes(id), 'quarantined');
    } finally { await collector.close(); }
  });

  await test('an event refused over and over eventually stops being retried', async () => {
    await resetState();
    const id = await appendEvent();
    const collector = await startCollector((body) => ({
      status: 200,
      json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'rejected', reason: 'timestamp_out_of_range' })) }
    }));
    try {
      let quarantined = false;
      for (let attempt = 0; attempt < 12 && !quarantined; attempt++) {
        const cursor = outbox.loadCursor();
        for (const entry of Object.values(cursor.deferred)) {
          entry.until = new Date(Date.now() - 1000).toISOString();
        }
        outbox.saveCursor(cursor);
        await client.push(config(collector.endpoint, CREDENTIAL_A));
        quarantined = outbox.loadCursor().rejected.includes(id);
      }
      assert.ok(quarantined, 'one endlessly refused event does not retry for ever');
    } finally { await collector.close(); }
  });

  // ---- behaviour that must not have changed --------------------------------

  await test('partial acceptance is still honoured', async () => {
    await resetState();
    const keep = await appendEvent();
    const drop = await appendEvent();
    const collector = await startCollector((body) => ({
      status: 200,
      json: {
        outcomes: body.events.map((e) => (e.eventId === keep
          ? { eventId: e.eventId, status: 'accepted' }
          : { eventId: e.eventId, status: 'rejected', reason: 'schema_invalid' }))
      }
    }));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1);
      assert.equal(result.rejected, 1);
      const cursor = outbox.loadCursor();
      assert.ok(cursor.sent.includes(keep), 'the accepted event is marked sent');
      assert.ok(cursor.rejected.includes(drop), 'the refused event is not marked sent');
      assert.ok(!cursor.sent.includes(drop), 'a refused event is never counted as delivered');
    } finally { await collector.close(); }
  });

  await test('a portal answer with no outcomes is still refused as invalid', async () => {
    await resetState();
    const id = await appendEvent();
    const collector = await startCollector(() => ({ status: 200, json: { ok: true } }));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.ok, false, 'an unusable answer is not treated as delivery');
      assert.equal(result.sent, 0);
      assert.ok(!outbox.loadCursor().sent.includes(id), 'the event is not marked sent');
    } finally { await collector.close(); }
  });

  // ---- a computer that was off or offline for months ----------------------

  await test('usage older than the 45-day scan window is still delivered', async () => {
    await resetState();
    const old = await appendEvent(60);      // two months ago
    const older = await appendEvent(120);   // four months ago
    const recent = await appendEvent(1);
    const seen = [];
    const collector = await startCollector((body) => {
      for (const e of body.events) seen.push(e.eventId);
      return { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } };
    });
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 3, 'all three are delivered, not just the recent one');
      assert.ok(seen.includes(old), 'the 60-day-old event reached the collector');
      assert.ok(seen.includes(older), 'the 120-day-old event reached the collector');
      assert.ok(seen.includes(recent), 'the recent event reached the collector');
    } finally { await collector.close(); }
  });

  await test('a long backlog is counted, not silently dropped', async () => {
    await resetState();
    await appendEvent(90);
    await appendEvent(2);
    const state = outbox.status();
    assert.equal(state.pendingTotal, 2, 'both are waiting to be delivered');
    const ninetyDaysAgo = new Date(Date.now() - 88 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    assert.ok(state.oldestPendingDay < ninetyDaysAgo,
      'the panel can say how far back the backlog reaches, got ' + state.oldestPendingDay);
  });

  await test('an old event delivered once is not offered again', async () => {
    const seen = [];
    const collector = await startCollector((body) => {
      for (const e of body.events) seen.push(e.eventId);
      return { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } };
    });
    try {
      const first = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(first.sent, 2);
      const second = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(second.sent, 0, 'nothing is re-sent');
      assert.equal(seen.length, 2, 'the collector saw each event exactly once');
      assert.equal(new Set(seen).size, 2, 'no duplicate ids');
      assert.equal(outbox.status().pendingTotal, 0);
    } finally { await collector.close(); }
  });

  await test('back-filled old usage found later is still picked up', async () => {
    // The delivery floor has just moved forward because the backlog cleared.
    // Usage the log reader only discovers now, dated inside the scan window,
    // must not fall behind that floor.
    const backfilled = await appendEvent(30);
    const seen = [];
    const collector = await startCollector((body) => {
      for (const e of body.events) seen.push(e.eventId);
      return { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } };
    });
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1, 'the newly discovered 30-day-old event is delivered');
      assert.ok(seen.includes(backfilled));
    } finally { await collector.close(); }
  });

  await test('an event the collector says nothing about stays pending', async () => {
    await resetState();
    const answered = await appendEvent();
    const ignored = await appendEvent();
    const collector = await startCollector((body) => ({
      status: 200,
      // Only one of the two events is mentioned in the answer.
      json: { outcomes: body.events.filter((e) => e.eventId === answered)
        .map((e) => ({ eventId: e.eventId, status: 'accepted' })) }
    }));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1, 'only the acknowledged event counts as sent');
      const cursor = outbox.loadCursor();
      assert.ok(cursor.sent.includes(answered));
      assert.ok(!cursor.sent.includes(ignored), 'an unmentioned event is NOT assumed delivered');
      assert.ok(!cursor.rejected.includes(ignored), 'nor is it thrown away');
      assert.ok(!cursor.deferred[ignored], 'nor is it held back');
    } finally { await collector.close(); }
  });

  await test('a cursor written by an older version still loads', async () => {
    fs.writeFileSync(
      path.join(scratch, 'sync-cursor.json'),
      JSON.stringify({ sent: ['old-1'], rejected: ['old-2'], lastSyncAt: '2026-01-01T00:00:00.000Z', sentTotal: 7 }),
      'utf8'
    );
    const cursor = outbox.loadCursor();
    assert.deepEqual(cursor.sent, ['old-1'], 'previous deliveries survive the upgrade');
    assert.deepEqual(cursor.rejected, ['old-2']);
    assert.equal(cursor.sentTotal, 7);
    assert.deepEqual(cursor.deferred, {}, 'nothing is held back');
    assert.equal(cursor.link.status, 'ok', 'the link is assumed good until refused');
    assert.equal(outbox.status().relinkRequired, false);
  });

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('\n' + f.name + '\n' + (f.err && f.err.stack));
    process.exit(1);
  }
})();
