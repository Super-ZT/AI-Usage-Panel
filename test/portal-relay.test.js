'use strict';

/**
 * Production-shaped Super ZT portal relay tests.
 *
 * Proves the desktop client can enroll, push real events over the mounted
 * portal contract (`/api/usage-panel/v1/*`), honour partial acceptance, and
 * surface a readable error when the credential is rejected — without ever
 * contacting the live internet.
 *
 * Run: node test/portal-relay.test.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-portal-relay-'));
process.env.USAGE_PANEL_DATA_DIR = path.join(scratch, 'data');
process.env.USAGE_PANEL_CONFIG_DIR = path.join(scratch, 'config');
process.env.USAGE_PANEL_ENROLLMENT_FILE = path.join(scratch, 'data', 'enrollment.json');

const client = require('../src/sync/client');
const events = require('../src/core/events');
const outbox = require('../src/sync/outbox');
const runtimeConfig = require('../src/core/runtime-config');
const localUsage = require('../src/core/local-usage');

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
    console.log('  FAIL ' + name + '\n       ' + (err && err.stack || err && err.message));
  }
}

/**
 * Minimal Super ZT portal stand-in. Records enrollments and events so the
 * test can assert both sides of the relay (client "sent" and portal store).
 */
function createPortalMock(options) {
  const opts = options || {};
  /** @type {Map<string, object>} */
  const devices = new Map();
  /** @type {Map<string, object>} */
  const storedEvents = new Map();
  let enrollments = 0;
  /** Mutable so a test can enroll, then force later pushes to 401. */
  const state = {
    forceRejectCredential: !!opts.forceRejectCredential,
    rejectEventIds: opts.rejectEventIds || new Set()
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url || '';
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
        return;
      }

      if (req.method === 'POST' && url === '/api/usage-panel/v1/enroll') {
        if (body.code === 'expired-code') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        if (typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.code)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
          return;
        }
        enrollments += 1;
        const credential = crypto.randomBytes(48).toString('base64url');
        const deviceId = crypto.randomUUID();
        devices.set(credential, {
          deviceId,
          label: body.label,
          platform: body.platform,
          revoked: false
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          deviceId,
          credential,
          credentialExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString()
        }));
        return;
      }

      if (req.method === 'POST' && url === '/api/usage-panel/v1/events') {
        const auth = req.headers.authorization || '';
        const match = /^Bearer ([A-Za-z0-9_-]{64})$/.exec(auth);
        if (!match || !devices.has(match[1]) || state.forceRejectCredential) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        const device = devices.get(match[1]);
        if (device.revoked) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        if (!body.events || !Array.isArray(body.events)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
          return;
        }

        const outcomes = [];
        for (const event of body.events) {
          // Portal-side contract checks (mirror super-zt-platform shape).
          const required = ['eventId', 'harness', 'provider', 'source', 'occurredAt'];
          const missing = required.some((key) => event[key] == null || event[key] === '');
          const badTime = typeof event.occurredAt !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T/.test(event.occurredAt);
          if (missing || badTime) {
            outcomes.push({ eventId: event.eventId || 'unknown', status: 'rejected', reason: 'invalid_event' });
            continue;
          }
          if (state.rejectEventIds.has(event.eventId)) {
            outcomes.push({ eventId: event.eventId, status: 'rejected', reason: 'invalid_event' });
            continue;
          }
          if (storedEvents.has(event.eventId)) {
            outcomes.push({ eventId: event.eventId, status: 'duplicate' });
            continue;
          }
          storedEvents.set(event.eventId, Object.assign({ deviceId: device.deviceId }, event));
          outcomes.push({ eventId: event.eventId, status: 'accepted' });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcomes }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  return {
    server,
    devices,
    storedEvents,
    state,
    enrollments: () => enrollments,
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
    endpoint() {
      return 'http://127.0.0.1:' + server.address().port + '/api/usage-panel';
    },
    /** Portal-side query: the same events a /portal/usage-panel snapshot would use. */
    portalSnapshot(harness) {
      const rows = [...storedEvents.values()].filter((e) => e.harness === (harness || 'claude-code'));
      return {
        devices: [...devices.values()].map((d) => ({
          id: d.deviceId, label: d.label, platform: d.platform, status: d.revoked ? 'revoked' : 'online'
        })),
        usage: {
          harness: harness || 'claude-code',
          eventCount: rows.length,
          inputTokens: rows.reduce((n, e) => n + (e.inputTokens || 0), 0),
          outputTokens: rows.reduce((n, e) => n + (e.outputTokens || 0), 0)
        },
        events: rows
      };
    }
  };
}

function sampleLocalEvent(over) {
  return Object.assign({
    device_id: 'device-local',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    ts: new Date().toISOString(),
    tokens: {
      in: 12, out: 4, cache_read: 0, cache_write: 10,
      cache_write_5m: 0, cache_write_1h: 10, cache_write_unresolved: 0,
      reasoning: 0, unattributed: 0
    },
    source: 'local_log',
    request_id: 'req-' + crypto.randomBytes(6).toString('hex')
  }, over || {});
}

(async () => {
  console.log('portal message relay tests\n');

  await test('portal contract routes match Super ZT mounted paths', () => {
    assert.strictEqual(
      client.collectorUrl('https://super-zt.com/api/usage-panel', 'enroll').href,
      'https://super-zt.com/api/usage-panel/v1/enroll'
    );
    assert.strictEqual(
      client.collectorUrl('https://super-zt.com/api/usage-panel', 'events').href,
      'https://super-zt.com/api/usage-panel/v1/events'
    );
    assert.ok(client.usesPortalContract(
      client.collectorUrl('https://super-zt.com/api/usage-panel', 'events')
    ));
    assert.ok(!client.usesPortalContract(
      client.collectorUrl('https://collector.example.com', 'events')
    ));
  });

  await test('enroll → push real events → portal store shows the same facts', async () => {
    const portal = createPortalMock({});
    await portal.listen();
    try {
      const endpoint = portal.endpoint();
      const enrolled = await client.enroll({
        endpoint,
        code: 'a'.repeat(32),
        label: 'relay-pc',
        allowInsecure: true
      });
      assert.ok(enrolled.deviceCredential);
      assert.ok(enrolled.deviceId);
      runtimeConfig.saveEnrollment({
        endpoint,
        deviceCredential: enrolled.deviceCredential,
        deviceId: enrolled.deviceId,
        allowInsecure: true
      });
      const saved = runtimeConfig.load(path.join(__dirname, '..'));
      assert.strictEqual(saved.sync.enabled, true);
      assert.strictEqual(saved.sync.endpoint, endpoint);
      assert.ok(saved.sync.endpoint.endsWith('/api/usage-panel'),
        'enrollment must store the portal base, not a bare host');

      const written = events.append(sampleLocalEvent({ device_id: enrolled.deviceId }));
      assert.strictEqual(written.written, true);
      await events.flush();

      const push = await client.push({
        endpoint,
        deviceCredential: enrolled.deviceCredential,
        deviceId: enrolled.deviceId,
        allowInsecure: true,
        batchSize: 50
      });
      assert.strictEqual(push.ok, true, push.message || 'push failed');
      assert.strictEqual(push.sent, 1);
      assert.strictEqual(push.rejected || 0, 0);

      const snapshot = portal.portalSnapshot('claude-code');
      assert.strictEqual(snapshot.usage.eventCount, 1, 'portal store must hold the accepted event');
      assert.strictEqual(snapshot.usage.inputTokens, 12);
      assert.strictEqual(snapshot.usage.outputTokens, 4);
      assert.strictEqual(snapshot.events[0].model, 'claude-haiku-4-5-20251001');
      assert.strictEqual(snapshot.events[0].harness, 'claude-code');
      assert.strictEqual(snapshot.events[0].eventId, written.event.event_id);
    } finally {
      await portal.close();
    }
  });

  await test('partial acceptance marks only accepted ids sent; rejected stay pending', async () => {
    const rejectIds = new Set();
    const portal = createPortalMock({ rejectEventIds: rejectIds });
    await portal.listen();
    try {
      const endpoint = portal.endpoint();
      const enrolled = await client.enroll({
        endpoint, code: 'b'.repeat(32), label: 'partial-pc', allowInsecure: true
      });
      const good = events.append(sampleLocalEvent({
        device_id: enrolled.deviceId, request_id: 'good-1',
        tokens: { in: 1, out: 1, cache_read: 0, cache_write: 0, reasoning: 0, unattributed: 0 }
      }));
      const bad = events.append(sampleLocalEvent({
        device_id: enrolled.deviceId, request_id: 'bad-1',
        tokens: { in: 2, out: 2, cache_read: 0, cache_write: 0, reasoning: 0, unattributed: 0 }
      }));
      rejectIds.add(bad.event.event_id);
      await events.flush();

      const push = await client.push({
        endpoint,
        deviceCredential: enrolled.deviceCredential,
        deviceId: enrolled.deviceId,
        allowInsecure: true
      });
      assert.strictEqual(push.ok, true);
      assert.strictEqual(push.sent, 1);
      assert.strictEqual(push.rejected, 1);

      const snapshot = portal.portalSnapshot('claude-code');
      assert.strictEqual(snapshot.usage.eventCount, 1);
      assert.strictEqual(snapshot.events[0].eventId, good.event.event_id);
      assert.ok(!snapshot.events.some((e) => e.eventId === bad.event.event_id));
    } finally {
      await portal.close();
    }
  });

  await test('rejected credential returns a readable error and does not mark events sent', async () => {
    const portal = createPortalMock({});
    await portal.listen();
    try {
      const endpoint = portal.endpoint();
      const enrolled = await client.enroll({
        endpoint, code: 'c'.repeat(32), label: 'auth-pc', allowInsecure: true
      });
      const written = events.append(sampleLocalEvent({
        device_id: enrolled.deviceId, request_id: 'auth-fail-1'
      }));
      await events.flush();
      // After enrollment, force every subsequent push to look like a revoke/401.
      portal.state.forceRejectCredential = true;

      const push = await client.pushOnce({
        endpoint,
        deviceCredential: enrolled.deviceCredential,
        deviceId: enrolled.deviceId,
        allowInsecure: true
      });
      assert.strictEqual(push.ok, false);
      assert.match(push.message || '', /credential|Authentication|rejected|linked/i);
      assert.strictEqual(push.sent, 0);
      assert.strictEqual(portal.portalSnapshot('claude-code').usage.eventCount, 0);
      // Pending outbox still contains the unsent event id.
      const pending = outbox.pending({ limit: 200, lookbackDays: 45 });
      assert.ok(pending.batch.some((e) => e.event_id === written.event.event_id)
        || pending.pendingTotal >= 1,
        'failed auth must leave the event pending for a later retry');
      // Isolate later tests: permanently park this event so a shared outbox
      // cannot inflate subsequent sent counts.
      outbox.markRejected([written.event.event_id]);
    } finally {
      await portal.close();
    }
  });

  await test('retry after success does not duplicate on the portal', async () => {
    const portal = createPortalMock({});
    await portal.listen();
    try {
      const endpoint = portal.endpoint();
      const enrolled = await client.enroll({
        endpoint, code: 'd'.repeat(32), label: 'retry-pc', allowInsecure: true
      });
      const written = events.append(sampleLocalEvent({
        device_id: enrolled.deviceId, request_id: 'retry-1'
      }));
      await events.flush();
      const cfg = {
        endpoint,
        deviceCredential: enrolled.deviceCredential,
        deviceId: enrolled.deviceId,
        allowInsecure: true
      };
      const first = await client.push(cfg);
      assert.strictEqual(first.sent, 1);
      // Re-append is a local duplicate; a second push of the same outbox window
      // should send nothing new.
      const second = await client.push(cfg);
      assert.strictEqual(second.sent, 0);
      assert.strictEqual(portal.portalSnapshot('claude-code').usage.eventCount, 1);
      assert.strictEqual(portal.portalSnapshot('claude-code').events[0].eventId, written.event.event_id);
    } finally {
      await portal.close();
    }
  });

  await test('unknown model from local logs is relayed as unknown, not a hardcoded grok id', async () => {
    const mapped = client.portalEvent({
      event_id: 'local_unknown_model',
      harness: 'grok-build',
      provider: 'x-ai',
      model: 'unknown',
      source: 'local_log',
      ts: '2026-08-08T12:00:00.000Z',
      tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0, unattributed: 50 }
    });
    assert.strictEqual(mapped.model, 'unknown');
    assert.notStrictEqual(mapped.model, 'grok-4.5');
  });

  await test('local-usage emits unknown for grok when summary has no model id', async () => {
    const grokHome = path.join(scratch, 'grok-home');
    const session = path.join(grokHome, 'sessions', 'sess-no-model');
    fs.mkdirSync(session, { recursive: true });
    // No summary.json → model must not be invented.
    fs.writeFileSync(path.join(session, 'updates.jsonl'),
      JSON.stringify({ totalTokens: 40, timestamp: Math.floor(Date.now() / 1000) - 10 }) + '\n'
      + JSON.stringify({ totalTokens: 90, timestamp: Math.floor(Date.now() / 1000) }) + '\n',
      'utf8');
    const result = await localUsage.bridge({
      claudeHome: path.join(scratch, 'no-claude'),
      codexHome: path.join(scratch, 'no-codex'),
      grokHome,
      device: { id: 'device-grok-unknown' },
      eventStore: events
    });
    assert.ok(result.written >= 1);
    const rows = events.read({}).filter((e) => e.harness === 'grok-build');
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((e) => e.model === 'unknown'),
      'missing summary must not invent grok-4.5');
  });

  console.log('');
  if (failures.length) {
    console.error(failures.length + ' failed, ' + passed + ' passed');
    process.exit(1);
  }
  console.log(passed + ' passed');
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
