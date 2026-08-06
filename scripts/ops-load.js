#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

if (!process.env.TEST_DATABASE_URL || process.env.OPS_ALLOW_SCHEMA_RESET !== '1') {
  console.error('TEST_DATABASE_URL and OPS_ALLOW_SCHEMA_RESET=1 are required for this destructive disposable-database harness');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-load-'));
process.env.USAGE_PANEL_DATA_DIR = path.join(scratch, 'desktop');

const repository = require('../server/repository');
const { createCollector } = require('../server/collector');
const events = require('../src/core/events');
const outbox = require('../src/sync/outbox');
const sync = require('../src/sync/client');

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function percentile(values, fraction) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] || 0;
}

function request(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const requestHeaders = Object.assign({}, headers || {});
    if (payload) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = payload.length;
    }
    const started = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: requestHeaders, agent: false }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch (_) { /* error response may be empty */ }
        resolve({ status: res.statusCode, json, raw, ms: Number(process.hrtime.bigint() - started) / 1e6, headers: res.headers });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

function cookie(response, name) {
  const values = response.headers['set-cookie'] || [];
  const value = values.find((candidate) => candidate.startsWith(name + '='));
  return value && value.split(';')[0];
}

async function login(port, email, password) {
  const pre = await request(port, 'GET', '/api/v1/manager/csrf');
  const result = await request(port, 'POST', '/api/v1/manager/login', { email, password }, {
    cookie: cookie(pre, 'up_prelogin_csrf'), 'x-csrf-token': pre.json.csrfToken
  });
  assert.strictEqual(result.status, 200);
  return { cookie: cookie(result, 'up_manager'), csrf: result.json.csrfToken };
}

async function managerPost(port, session, route, body) {
  return request(port, 'POST', route, body || {}, { cookie: session.cookie, 'x-csrf-token': session.csrf });
}

async function enroll(port, session, label) {
  const code = await managerPost(port, session, '/api/v1/manager/enrollment-codes', { ttlMinutes: 15 });
  assert.strictEqual(code.status, 201);
  const enrolled = await request(port, 'POST', '/api/v1/enroll', {
    code: code.json.enrollmentCode, label, platform: 'load-test'
  });
  assert.strictEqual(enrolled.status, 201);
  return enrolled.json;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

(async () => {
  const eventsPerDevice = bounded(process.env.OPS_EVENTS_PER_DEVICE, 100, 1, 200);
  const soakSeconds = bounded(process.env.OPS_SOAK_SECONDS, 2, 1, 30);
  const pool = repository.createPool(process.env.TEST_DATABASE_URL);
  let collector;
  let activePool = pool;
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await repository.migrate(pool);
    await repository.bootstrapCompany(pool, {
      slug: 'load-a', name: 'Load Company A', email: 'load-a@example.test', password: 'load company password a'
    });
    await repository.bootstrapCompany(pool, {
      slug: 'load-b', name: 'Load Company B', email: 'load-b@example.test', password: 'load company password b'
    });
    collector = createCollector({ pool, keepPoolOpen: true, rateLimitSecret: 'load-test-rate-secret'.repeat(2) });
    await new Promise((resolve) => collector.server.listen(0, '127.0.0.1', resolve));
    const port = collector.server.address().port;
    const endpoint = 'http://127.0.0.1:' + port;
    const managers = [
      await login(port, 'load-a@example.test', 'load company password a'),
      await login(port, 'load-b@example.test', 'load company password b')
    ];
    const devices = [[], []];
    for (let companyIndex = 0; companyIndex < 2; companyIndex++) {
      for (let index = 0; index < 5; index++) devices[companyIndex].push(await enroll(port, managers[companyIndex], 'shared-label'));
    }

    const rssBefore = process.memoryUsage().rss;
    const uploadLatencies = [];
    let accepted = 0;
    const uploadStarted = process.hrtime.bigint();
    for (let companyIndex = 0; companyIndex < devices.length; companyIndex++) {
      for (let deviceIndex = 0; deviceIndex < devices[companyIndex].length; deviceIndex++) {
        const device = devices[companyIndex][deviceIndex];
        const batch = [];
        for (let index = 0; index < eventsPerDevice; index++) batch.push({
          event_id: `load-${companyIndex}-${deviceIndex}-${String(index).padStart(4, '0')}`,
          harness: index % 2 ? 'claude-code' : 'codex', provider: 'load',
          model: index % 7 ? 'anthropic/claude-opus-4.6' : 'does-not-exist/model',
          pricing_model: index % 7 ? 'anthropic/claude-opus-4.6' : 'does-not-exist/model',
          ts: new Date().toISOString(), tokens: { in: 10, out: 2, cache_read: 3, cache_write: 1 }, source: 'local-log'
        });
        batch.push({ ...batch[0], event_id: `poison-${companyIndex}-${deviceIndex}`, model: 'bad\u0000model' });
        const headers = { authorization: 'Bearer ' + device.deviceCredential };
        const first = await request(port, 'POST', '/api/v1/events', { events: batch }, headers);
        assert.strictEqual(first.status, 200); assert.strictEqual(first.json.accepted.length, eventsPerDevice);
        assert.strictEqual(first.json.rejected, 1); accepted += first.json.accepted.length; uploadLatencies.push(first.ms);
        const replay = await request(port, 'POST', '/api/v1/events', { events: batch }, headers);
        assert.strictEqual(replay.status, 200); assert.strictEqual(replay.json.duplicates, eventsPerDevice);
        assert.strictEqual(replay.json.rejected, 1);
      }
    }
    const uploadMs = Number(process.hrtime.bigint() - uploadStarted) / 1e6;

    const reads = [];
    for (let index = 0; index < 20; index++) reads.push(request(
      port, 'GET', '/api/v1/fleet?days=30', null, { cookie: managers[index % 2].cookie }
    ));
    const readResults = await Promise.all(reads);
    assert.ok(readResults.every((result) => result.status === 200));
    const expectedPerCompany = 5 * eventsPerDevice;
    assert.ok(readResults.every((result) => result.json.totalEvents === expectedPerCompany));
    assert.ok(readResults.every((result) => result.json.devices.length === 5));

    const revoked = devices[0][4];
    const revoke = await managerPost(port, managers[0], '/api/v1/manager/devices/' + revoked.deviceId + '/revoke', {});
    assert.strictEqual(revoke.status, 200);
    assert.strictEqual((await request(port, 'POST', '/api/v1/events', { events: [] }, {
      authorization: 'Bearer ' + revoked.deviceCredential
    })).status, 401);

    events.append({
      event_id: 'outage-recovery-event-0001', harness: 'codex', provider: 'load', model: 'openai/gpt-5.2',
      ts: new Date().toISOString(), tokens: { in: 33, out: 4 }, source: 'local-log'
    });
    await events.flush();
    await closeServer(collector.server);
    const outage = await sync.push({ endpoint, deviceCredential: devices[0][0].deviceCredential });
    assert.strictEqual(outage.ok, false); assert.strictEqual(outbox.pending().pendingTotal, 1);

    collector = createCollector({ pool, keepPoolOpen: true, rateLimitSecret: 'load-test-rate-secret'.repeat(2) });
    await new Promise((resolve) => collector.server.listen(port, '127.0.0.1', resolve));
    let recovered;
    let recoveryAttempts = 0;
    while (recoveryAttempts < 5) {
      recoveryAttempts++;
      recovered = await sync.push({ endpoint, deviceCredential: devices[0][0].deviceCredential });
      if (recovered.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
    assert.strictEqual(recovered.sent, 1); assert.strictEqual(outbox.pending().pendingTotal, 0);

    await closeServer(collector.server);
    await pool.end();
    activePool = repository.createPool(process.env.TEST_DATABASE_URL);
    collector = createCollector({ pool: activePool, keepPoolOpen: true, rateLimitSecret: 'load-test-rate-secret'.repeat(2) });
    await new Promise((resolve) => collector.server.listen(port, '127.0.0.1', resolve));
    const afterRestart = await request(port, 'GET', '/api/v1/fleet?days=30', null, { cookie: managers[0].cookie });
    assert.strictEqual(afterRestart.status, 200); assert.strictEqual(afterRestart.json.totalEvents, expectedPerCompany + 1);

    const soakLatencies = [];
    const soakRequests = Math.min(100, soakSeconds * 20);
    for (let index = 0; index < soakRequests; index++) {
      const response = await request(port, 'GET', '/api/v1/fleet?days=365', null, { cookie: managers[index % 2].cookie });
      assert.strictEqual(response.status, 200); soakLatencies.push(response.ms);
    }
    const rssAfter = process.memoryUsage().rss;
    const stored = await activePool.query('SELECT company_id,count(*)::int AS events FROM usage_events GROUP BY company_id ORDER BY company_id');
    assert.deepStrictEqual(stored.rows.map((row) => row.events).sort((a, b) => a - b), [expectedPerCompany, expectedPerCompany + 1]);

    console.log(JSON.stringify({
      profile: { companies: 2, devices: 10, eventsPerDevice, soakSeconds, concurrentReads: 20 },
      upload: {
        accepted, poisonRejected: 10, duplicateReplay: accepted,
        elapsedMs: Number(uploadMs.toFixed(1)), eventsPerSecond: Number((accepted / (uploadMs / 1000)).toFixed(1)),
        p95BatchMs: Number(percentile(uploadLatencies, 0.95).toFixed(1))
      },
      reads: {
        concurrentP95Ms: Number(percentile(readResults.map((result) => result.ms), 0.95).toFixed(1)),
        soakRequests, soakP95Ms: Number(percentile(soakLatencies, 0.95).toFixed(1))
      },
      outage: { queuedDuringOutage: 1, deliveredAfterRecovery: 1, pendingAfterRecovery: 0, recoveryAttempts },
      restart: { durableCompanyEventCounts: stored.rows.map((row) => row.events).sort((a, b) => a - b) },
      memory: { rssBefore, rssAfter, rssDelta: rssAfter - rssBefore }
    }));
  } finally {
    if (collector && collector.server.listening) await closeServer(collector.server);
    if (activePool) await activePool.end().catch(() => {});
    if (activePool !== pool) await pool.end().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
