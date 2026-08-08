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


/**
 * A collector with a strict schema, like the real portal: any key it does not
 * know rejects the whole batch with 400. `allowed` is the exact key set.
 */
const BASE_KEYS = ['eventId', 'harness', 'provider', 'model', 'source', 'inputTokens',
  'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens',
  'cacheWriteUnresolvedTokens', 'occurredAt'];
const PRICING_KEYS = BASE_KEYS.concat(['pricingModel']);
const EVIDENCE_KEYS = PRICING_KEYS.concat(['harnessEvidence', 'harnessVerified',
  'modelEvidence', 'modelVerified']);

function strictCollector(allowed, seen) {
  return (body) => {
    for (const event of body.events) {
      for (const key of Object.keys(event)) {
        if (!allowed.includes(key)) return { status: 400, json: { error: 'Invalid request' } };
      }
    }
    if (seen) for (const event of body.events) seen.push(event);
    return { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } };
  };
}

let eventSeq = 0;
/**
 * Append one real usage event, flush it to disk, and return its stable id.
 * @param {number} [ageDays=0] how long ago the usage happened
 */
async function appendEvent(ageDays, extra) {
  eventSeq++;
  const age = (Number(ageDays) || 0) * 24 * 3600 * 1000;
  const result = events.append(Object.assign({
    device_id: 'device-under-test',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-5',
    ts: new Date(Date.now() - age - 60000 - eventSeq * 1000).toISOString(),
    tokens: { in: 1000 + eventSeq, out: 500, cache_read: 0, cache_write: 0 },
    source: 'local_log'
  }, extra || {}));
  assert.ok(result.written, 'test event was written: ' + (result.reason || ''));
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
    // The dangerous state: the only thing waiting is today's usage, so the
    // delivery floor is computed from a recent day. Usage the log reader only
    // discovers afterwards, dated earlier but still inside the scan window,
    // must not fall behind that floor.
    await resetState();
    const today = await appendEvent(0);
    const beforeFloor = outbox.status();          // forces the floor to be computed
    assert.equal(beforeFloor.pendingTotal, 1, 'only today\'s usage is waiting');
    assert.ok(outbox.loadCursor().deliveryFloor, 'a delivery floor has been recorded');

    const backfilled = await appendEvent(30);     // discovered only now
    const seen = [];
    const collector = await startCollector((body) => {
      for (const e of body.events) seen.push(e.eventId);
      return { status: 200, json: { outcomes: body.events.map((e) => ({ eventId: e.eventId, status: 'accepted' })) } };
    });
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 2, 'both the recent and the back-filled event are delivered');
      assert.ok(seen.includes(backfilled), 'the 30-day-old event was not hidden behind the floor');
      assert.ok(seen.includes(today));
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


  // ---- what the upload carries -------------------------------------------

  await test('the catalogue id for an unpriceable model string is sent', async () => {
    await resetState();
    outbox.setContractTier('full');
    await appendEvent(0, { model: 'codex-auto-review', pricing_model: 'openai/gpt-5.6-sol' });
    const seen = [];
    const collector = await startCollector(strictCollector(EVIDENCE_KEYS, seen));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1);
      assert.equal(seen[0].model, 'codex-auto-review', 'the raw model is still what is displayed');
      assert.equal(seen[0].pricingModel, 'openai/gpt-5.6-sol', 'the portal can now price it');
    } finally { await collector.close(); }
  });

  await test('evidence is passed through as stored, and never invented when absent', async () => {
    await resetState();
    outbox.setContractTier('full');
    await appendEvent(0, { source: 'local_log' });
    const seen = [];
    const collector = await startCollector(strictCollector(EVIDENCE_KEYS, seen));
    try {
      await client.push(config(collector.endpoint, CREDENTIAL_A));
      const stored = events.read({ from: '1970-01-01' })
        .find((e) => e.event_id === seen[0].eventId);
      // Holds whether or not this build's store records evidence: the wire
      // carries exactly what was stored, and 'unknown' when nothing was.
      assert.equal(seen[0].harnessEvidence,
        typeof stored.harness_evidence === 'string' ? stored.harness_evidence : 'unknown');
      assert.equal(seen[0].modelEvidence,
        typeof stored.model_evidence === 'string' ? stored.model_evidence : 'unknown');
      assert.equal(seen[0].harnessVerified, stored.harness_verified === true);
      assert.equal(seen[0].modelVerified, stored.model_verified === true);
      assert.equal(seen[0].harnessVerified, false, 'nothing claims a verified harness');
    } finally { await collector.close(); }
  });

  await test('an event carrying no evidence at all is sent as unknown, never inferred', async () => {
    // Deterministic at any base: a bare event object, not one the store shaped.
    const wire = client.portalEvent({
      event_id: 'bare-1', harness: 'claude-code', provider: 'anthropic',
      model: 'claude-opus-5', source: 'local_log', ts: new Date().toISOString(),
      tokens: { in: 10, out: 5 }
    }, 'full');
    assert.equal(wire.harnessEvidence, 'unknown', 'no provenance is inferred from the source field');
    assert.equal(wire.modelEvidence, 'unknown');
    assert.equal(wire.harnessVerified, false);
    assert.equal(wire.modelVerified, false);
  });

  await test('the displayed model is exactly what the store holds, never substituted', async () => {
    await resetState();
    outbox.setContractTier('full');
    const stored = events.read({ from: '1970-01-01' });
    await appendEvent(0, { model: 'claude-opus-5' });
    const seen = [];
    const collector = await startCollector(strictCollector(EVIDENCE_KEYS, seen));
    try {
      await client.push(config(collector.endpoint, CREDENTIAL_A));
      const after = events.read({ from: '1970-01-01' })
        .find((e) => e.event_id === seen[0].eventId);
      assert.equal(seen[0].model, after.model, 'the wire model equals the stored model');
      assert.ok(stored.length >= 0);
      // When the store nulls a model it judged unverified, the wire carries the
      // null. Proven directly: a stored null must not be replaced by anything.
      const nulled = Object.assign({}, after, { model: null, observed_model: 'pretend-model-9' });
      const wire = client.portalEvent(nulled, 'full');
      assert.equal(wire.model, null, 'a stored null model stays null on the wire');
      assert.ok(!JSON.stringify(wire).includes('pretend-model-9'),
        'an observed-but-unverified string never reaches the portal');
    } finally { await collector.close(); }
  });

  // ---- talking to a collector older than this device ----------------------

  await test('a collector that does not know the evidence fields still gets the usage', async () => {
    await resetState();
    outbox.setContractTier('full');
    await appendEvent(0, { model: 'codex-auto-review', pricing_model: 'openai/gpt-5.6-sol' });
    const seen = [];
    const collector = await startCollector(strictCollector(PRICING_KEYS, seen));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1, 'the usage is delivered, not lost to a schema mismatch');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].pricingModel, 'openai/gpt-5.6-sol', 'the field it DOES know is still sent');
      assert.equal(seen[0].harnessEvidence, undefined, 'the field it does not know is dropped');
      assert.equal(outbox.loadCursor().contract.tier, 'pricing', 'the narrowing is remembered');
    } finally { await collector.close(); }
  });

  await test('today\'s live portal, which knows neither field, still gets the usage', async () => {
    await resetState();
    outbox.setContractTier('full');
    await appendEvent(0, { pricing_model: 'openai/gpt-5.6-sol' });
    const seen = [];
    const collector = await startCollector(strictCollector(BASE_KEYS, seen));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1, 'usage still reaches an un-upgraded portal');
      assert.equal(seen[0].pricingModel, undefined);
      assert.equal(seen[0].modelEvidence, undefined);
      assert.equal(outbox.loadCursor().contract.tier, 'base');
    } finally { await collector.close(); }
  });

  await test('the narrowed contract is not re-tried on every push', async () => {
    await appendEvent(0);
    let refusals = 0;
    const collector = await startCollector((body) => {
      const answer = strictCollector(BASE_KEYS)(body);
      if (answer.status === 400) refusals++;
      return answer;
    });
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1);
      assert.equal(refusals, 0, 'the device remembered and did not offer a rejected shape again');
    } finally { await collector.close(); }
  });

  await test('an upgraded portal starts receiving the richer fields again', async () => {
    await resetState();
    // The device narrowed six hours ago; the website has been upgraded since.
    outbox.setContractTier('base', Date.now() - 7 * 3600 * 1000);
    await appendEvent(0, { pricing_model: 'openai/gpt-5.6-sol' });
    const seen = [];
    const collector = await startCollector(strictCollector(EVIDENCE_KEYS, seen));
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.sent, 1);
      assert.equal(seen[0].pricingModel, 'openai/gpt-5.6-sol', 'the richer contract is offered again');
      assert.ok(seen[0].modelEvidence, 'and accepted');
    } finally { await collector.close(); }
  });

  await test('a batch that is bad for some other reason is reported, not looped', async () => {
    await resetState();
    await appendEvent(0);
    let requests = 0;
    const collector = await startCollector(() => {
      requests++;
      return { status: 400, json: { error: 'Invalid request' } };
    });
    try {
      const result = await client.push(config(collector.endpoint, CREDENTIAL_A));
      assert.equal(result.ok, false, 'reported as a failure');
      assert.match(result.message, /400/);
      assert.ok(requests <= 3, 'it stops after stepping through the tiers, got ' + requests);
      assert.equal(outbox.status().pendingTotal, 1, 'the usage is still queued, not lost');
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
