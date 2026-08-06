'use strict';

/**
 * Real PostgreSQL and HTTP boundary tests. TEST_DATABASE_URL must point at a
 * disposable database because this suite recreates its public schema.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL must point to a disposable PostgreSQL database');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-security-'));
process.env.USAGE_PANEL_DATA_DIR = path.join(scratch, 'device-data');

const repository = require('../server/repository');
const { createCollector } = require('../server/collector');
const security = require('../server/security');
const pricing = require('../src/core/pricing');
const localUsage = require('../src/core/local-usage');
const events = require('../src/core/events');
const outbox = require('../src/sync/outbox');
const sync = require('../src/sync/client');
const { importFlat } = require('../server/import-flat');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  FAIL ' + name + '\n       ' + err.message); }
}

const csrfByManagerToken = new Map();

function request(port, method, route, body, token, rawBody, options) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null ? Buffer.from(rawBody) : body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({}, options && options.headers);
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    if (token) headers.authorization = 'Bearer ' + token;
    if (method !== 'GET' && token && csrfByManagerToken.has(token) && !(options && options.skipManagerCsrf)) {
      headers['x-csrf-token'] = csrfByManagerToken.get(token);
    }
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* expected for no JSON only */ }
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

async function login(port, email, password, rawBody) {
  const csrf = await request(port, 'GET', '/api/v1/manager/csrf');
  const cookie = String(csrf.headers['set-cookie'][0]).split(';')[0];
  const result = await request(port, 'POST', '/api/v1/manager/login', rawBody ? null : { email, password },
    null, rawBody, { headers: { cookie, 'x-csrf-token': csrf.json.csrfToken } });
  if (result.status === 200) {
    const token = decodeURIComponent(String(result.headers['set-cookie'][0]).match(/up_manager=([^;]+)/)[1]);
    csrfByManagerToken.set(token, result.json.csrfToken);
  }
  return result;
}

async function createEnrolledDevice(port, managerToken, label) {
  const code = await request(port, 'POST', '/api/v1/manager/enrollment-codes', { ttlMinutes: 15 }, managerToken);
  assert.strictEqual(code.status, 201);
  const enrolled = await request(port, 'POST', '/api/v1/enroll', {
    code: code.json.enrollmentCode, label, platform: 'test'
  });
  assert.strictEqual(enrolled.status, 201);
  return { code: code.json.enrollmentCode, ...enrolled.json };
}

(async () => {
  console.log('company security / PostgreSQL tests\n');
  const pool = repository.createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const migrationNames = await repository.migrate(pool);
  const companyA = await repository.bootstrapCompany(pool, {
    slug: 'acme', name: 'Acme Company', email: 'boss@acme.test', password: 'correct horse battery staple'
  });
  const companyB = await repository.bootstrapCompany(pool, {
    slug: 'beta', name: 'Beta Company', email: 'boss@beta.test', password: 'another correct horse battery'
  });
  const collector = createCollector({ pool, keepPoolOpen: true });
  await new Promise((resolve) => collector.server.listen(0, '127.0.0.1', resolve));
  const port = collector.server.address().port;
  const endpoint = 'http://127.0.0.1:' + port;

  let managerA, managerB, deviceA, deviceB;

  await test('collector fails closed when PostgreSQL is not configured', () => {
    const env = Object.assign({}, process.env, { DATABASE_URL: '' });
    const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'collector.js')], {
      cwd: scratch, env, encoding: 'utf8', timeout: 5000
    });
    assert.strictEqual(child.status, 1);
    assert.match(child.stderr, /could not start/);
    assert.ok(!fs.existsSync(path.join(scratch, 'collector-data')), 'no flat-file fallback may appear');
  });

  await test('exact ordered migrations create the durable schema', async () => {
    assert.deepStrictEqual(migrationNames, ['001_company_security.sql', '002_indexes.sql', '003_manager_dashboard.sql',
      '004_operations_readiness.sql', '005_operations_constraints.sql', '006_user_accounts.sql',
      '007_pricing_catalogue_index.sql']);
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const names = tables.rows.map((row) => row.tablename);
    for (const name of ['companies','users','company_memberships','managers','manager_sessions','user_sessions',
      'devices','enrollment_codes','usage_events','usage_rejections','audit_facts','api_rate_limits','schema_migrations']) {
      assert.ok(names.includes(name), name);
    }
  });

  await test('manager passwords are salted hashes, never stored as text', async () => {
    const row = (await pool.query('SELECT password_salt, password_hash FROM managers WHERE id=$1',
      [companyA.manager.id])).rows[0];
    assert.ok(Buffer.isBuffer(row.password_salt) && row.password_salt.length === 16);
    assert.ok(Buffer.isBuffer(row.password_hash) && row.password_hash.length === 64);
    assert.ok(!row.password_hash.includes(Buffer.from('correct horse')));
  });

  await test('public plaintext endpoints are refused while loopback and HTTPS remain valid', () => {
    assert.throws(() => sync.validateEndpoint('http://example.com/api/v1/events', false), /plaintext/);
    assert.ok(sync.validateEndpoint('http://127.0.0.1:8900/api/v1/events', false));
    assert.ok(sync.validateEndpoint('https://usage.example/api/v1/events', false));
    assert.throws(() => sync.validateEndpoint('https://usage.example?redirect=elsewhere', false), /query string/);
    assert.throws(() => sync.validateEndpoint('https://usage.example/#fragment', false), /fragment/);
  });

  await test('wrong password returns one generic authentication failure', async () => {
    const res = await login(port, 'boss@acme.test', 'definitely-wrong');
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(res.json, { error: 'invalid credentials' });
  });

  await test('legitimate managers receive separate expiring sessions', async () => {
    const a = await login(port, 'boss@acme.test', 'correct horse battery staple');
    const b = await login(port, 'boss@beta.test', 'another correct horse battery');
    assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
    assert.ok(!Object.prototype.hasOwnProperty.call(a.json, 'sessionToken'), 'session secret must not enter JSON');
    managerA = String(a.headers['set-cookie'][0]).match(/up_manager=([^;]+)/)[1];
    managerB = String(b.headers['set-cookie'][0]).match(/up_manager=([^;]+)/)[1];
    csrfByManagerToken.set(managerA, a.json.csrfToken); csrfByManagerToken.set(managerB, b.json.csrfToken);
    assert.match(managerA, /^upm_/); assert.notStrictEqual(managerA, managerB);
    assert.ok(new Date(a.json.expiresAt) > new Date());
  });

  await test('anonymous and missing-claim sessions cannot read a fleet', async () => {
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet')).status, 401);
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet', null, 'upm_missing_claim')).status, 401);
  });

  await test('one-use enrollment creates unique upload-only credentials', async () => {
    deviceA = await createEnrolledDevice(port, managerA, 'office-pc');
    deviceB = await createEnrolledDevice(port, managerB, 'office-pc');
    assert.match(deviceA.deviceCredential, /^upd_/);
    assert.notStrictEqual(deviceA.deviceCredential, deviceB.deviceCredential);
    const replay = await request(port, 'POST', '/api/v1/enroll', {
      code: deviceA.code, label: 'replayed', platform: 'test'
    });
    assert.strictEqual(replay.status, 401);
    const stored = await pool.query('SELECT credential_hash FROM devices WHERE id=$1', [deviceA.deviceId]);
    assert.ok(Buffer.isBuffer(stored.rows[0].credential_hash));
    assert.notStrictEqual(stored.rows[0].credential_hash.toString(), deviceA.deviceCredential);
  });

  await test('simultaneous enrollment attempts consume a code exactly once', async () => {
    const code = await request(port, 'POST', '/api/v1/manager/enrollment-codes', { ttlMinutes: 15 }, managerA);
    assert.strictEqual(code.status, 201);
    const body = { code: code.json.enrollmentCode, label: 'race-device', platform: 'test' };
    const attempts = await Promise.all([
      request(port, 'POST', '/api/v1/enroll', body),
      request(port, 'POST', '/api/v1/enroll', body)
    ]);
    assert.deepStrictEqual(attempts.map((entry) => entry.status).sort(), [201, 401]);
    const stored = await pool.query(
      "SELECT count(*) FROM devices WHERE company_id=$1 AND label='race-device'",
      [companyA.company.id]
    );
    assert.strictEqual(Number(stored.rows[0].count), 1);
  });

  await test('expired enrollment codes fail without creating a device', async () => {
    const code = await request(port, 'POST', '/api/v1/manager/enrollment-codes', { ttlMinutes: 1 }, managerA);
    await pool.query(`UPDATE enrollment_codes
      SET created_at=now()-interval '2 minutes', expires_at=now()-interval '1 minute'
      WHERE code_hash=$1`,
      [security.tokenHash(code.json.enrollmentCode)]);
    const res = await request(port, 'POST', '/api/v1/enroll', {
      code: code.json.enrollmentCode, label: 'late', platform: 'test'
    });
    assert.strictEqual(res.status, 401);
  });

  await test('device credentials cannot read and manager sessions cannot upload', async () => {
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet', null, deviceA.deviceCredential)).status, 403);
    assert.strictEqual((await request(port, 'POST', '/api/v1/events', { events: [] }, managerA)).status, 403);
  });

  await test('the production desktop client uploads under server-derived identity', async () => {
    events.append({
      event_id: 'shared-company-event-0001', device_id: 'forged-device', harness: 'claude-code',
      provider: 'anthropic', model: 'claude-opus-4-8', ts: new Date().toISOString(),
      tokens: { in: 100, out: 20, cache_read: 300, cache_write: 40 }, source: 'local-log'
    });
    await events.flush();
    const result = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.strictEqual(result.ok, true); assert.strictEqual(result.sent, 1);
    const row = (await pool.query('SELECT company_id,device_id,tokens FROM usage_events WHERE event_id=$1',
      ['shared-company-event-0001'])).rows[0];
    assert.strictEqual(row.company_id, companyA.company.id);
    assert.strictEqual(row.device_id, deviceA.deviceId);
  });

  await test('real-shaped Claude, Codex and Grok bridge facts match collector token categories', async () => {
    const homes = {
      claudeHome: path.join(scratch, 'fixture-claude'),
      codexHome: path.join(scratch, 'fixture-codex'),
      grokHome: path.join(scratch, 'fixture-grok')
    };
    const claudeFile = path.join(homes.claudeHome, 'projects', 'p', 'session.jsonl');
    const codexFile = path.join(homes.codexHome, 'sessions', 'rollout-parity.jsonl');
    const grokDir = path.join(homes.grokHome, 'sessions', 'grok');
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.mkdirSync(grokDir, { recursive: true });
    const base = { type: 'assistant', timestamp: new Date().toISOString(), requestId: 'bridge-request',
      message: { id: 'bridge-message', model: 'claude-opus-4-8', usage: {
        input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40
      } } };
    const duplicate = JSON.parse(JSON.stringify(base)); duplicate.timestamp = new Date(Date.now() + 5).toISOString();
    const growing = JSON.parse(JSON.stringify(base)); growing.timestamp = new Date(Date.now() + 10).toISOString();
    growing.message.usage.output_tokens = 30; growing.message.usage.cache_read_input_tokens = 320;
    fs.writeFileSync(claudeFile, [base, duplicate, growing].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(codexFile, [
      { timestamp: new Date().toISOString(), payload: { model: 'gpt-5.6-sol' } },
      { timestamp: new Date(Date.now() + 1000).toISOString(), payload: { info: { total_token_usage: {
        input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, cache_write_input_tokens: 10
      } } } }
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(path.join(grokDir, 'summary.json'), JSON.stringify({ current_model_id: 'grok-4.5' }));
    fs.writeFileSync(path.join(grokDir, 'updates.jsonl'), JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000), _meta: { totalTokens: 50 }
    }) + '\n');
    const before = (await request(port, 'GET', '/api/v1/fleet', null, managerA)).json;
    const bridged = await localUsage.bridge(Object.assign({
      device: { id: deviceA.deviceId }, eventStore: events, codexPriceModel: 'gpt-5.6-sol'
    }, homes));
    assert.strictEqual(bridged.written, 4);
    assert.strictEqual((await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential })).sent, 4);
    const after = (await request(port, 'GET', '/api/v1/fleet', null, managerA)).json;
    assert.strictEqual(after.byHarness['claude-code'].tokens.in - before.byHarness['claude-code'].tokens.in, 100);
    assert.strictEqual(after.byHarness['claude-code'].tokens.out - before.byHarness['claude-code'].tokens.out, 30);
    assert.strictEqual(after.byHarness['claude-code'].tokens.cache_read - before.byHarness['claude-code'].tokens.cache_read, 320);
    assert.strictEqual(after.byHarness['claude-code'].tokens.cache_write - before.byHarness['claude-code'].tokens.cache_write, 40);
    assert.strictEqual(after.byHarness.codex.tokens.in, 50);
    assert.strictEqual(after.byHarness.codex.tokens.cache_read, 40);
    assert.strictEqual(after.byHarness.codex.tokens.cache_write, 10);
    assert.strictEqual(after.byHarness.codex.tokens.out, 20);
    assert.strictEqual(after.byHarness.codex.evidence.tokenDetail, 'exact');
    assert.strictEqual(after.byHarness.codex.evidence.modelIdentity, 'exact');
    assert.strictEqual(after.byHarness.codex.evidence.providerEventReconciliation, 'unknown');
    assert.strictEqual(after.byHarness.codex.evidence.accountWindow, 'unknown');
    assert.strictEqual(after.byHarness['grok-build'].tokens.unattributed, 50);
    assert.strictEqual((await localUsage.bridge(Object.assign({
      device: { id: deviceA.deviceId }, eventStore: events, codexPriceModel: 'gpt-5.6-sol'
    }, homes))).written, 0, 'restart-safe checkpoint must emit nothing twice');
  });

  await test('real Codex subscription probe survives log, upload, database and manager totals exactly', async () => {
    const realHome = path.join(scratch, 'real-codex-probe');
    const realFile = path.join(realHome, 'sessions', '2026', '08',
      'rollout-synthetic-codex-accuracy-probe.jsonl');
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    const fixtureRows = fs.readFileSync(path.join(
      __dirname, '..', 'scripts', 'fixtures', 'codex-real-probe-2026-08-06.jsonl'
    ), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const fixtureTime = Date.now();
    fs.writeFileSync(realFile, fixtureRows.map((row, index) => JSON.stringify(Object.assign({}, row, {
      timestamp: new Date(fixtureTime + index).toISOString()
    }))).join('\n') + '\n');
    const beforeEvents = new Set(events.read({}).map((event) => event.event_id));
    const before = (await request(port, 'GET', '/api/v1/fleet', null, managerA)).json;
    const bridged = await localUsage.bridge({
      claudeHome: path.join(scratch, 'real-probe-empty-claude'),
      codexHome: realHome,
      grokHome: path.join(scratch, 'real-probe-empty-grok'),
      device: { id: deviceA.deviceId }, eventStore: events
    });
    assert.strictEqual(bridged.written, 1);
    const event = events.read({}).find((candidate) => !beforeEvents.has(candidate.event_id));
    assert.ok(event, 'the real probe event must enter the local outbox');
    assert.strictEqual(event.model, 'gpt-5.6-sol');
    assert.strictEqual(event.pricing_model, 'gpt-5.6-sol');
    assert.deepStrictEqual(event.tokens, {
      in: 15896, out: 15, cache_read: 3712, cache_write: 0,
      cache_write_5m: 0, cache_write_1h: 0, cache_write_unresolved: 0,
      reasoning: 0, unattributed: 0
    });
    const pushed = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.strictEqual(pushed.ok, true); assert.strictEqual(pushed.sent, 1);
    const after = (await request(port, 'GET', '/api/v1/fleet', null, managerA)).json;
    for (const [name, expected] of Object.entries({ in: 15896, out: 15, cache_read: 3712, cache_write: 0 })) {
      assert.strictEqual(after.byHarness.codex.tokens[name] - before.byHarness.codex.tokens[name], expected, name);
    }
    const displayed = after.byModel['gpt-5.6-sol'];
    assert.ok(displayed, 'manager response must expose the exact Codex model');
    assert.strictEqual(displayed.evidence.tokenDetail, 'exact');
    assert.strictEqual(displayed.evidence.modelIdentity, 'exact');
    assert.strictEqual(displayed.evidence.providerEventReconciliation, 'unknown');
    assert.strictEqual(displayed.evidence.accountWindow, 'unknown');
    const stored = (await pool.query(
      'SELECT model,pricing_model,tokens FROM usage_events WHERE company_id=$1 AND event_id=$2',
      [companyA.company.id, event.event_id]
    )).rows[0];
    assert.strictEqual(stored.model, 'gpt-5.6-sol');
    assert.strictEqual(stored.pricing_model, 'gpt-5.6-sol');
    assert.deepStrictEqual(stored.tokens, event.tokens);
    const estimate = pricing.priceTokens(stored.pricing_model, stored.tokens);
    assert.strictEqual(estimate.version, 'openrouter-2026-08-03');
    assert.strictEqual(estimate.status, 'priced');
    assert.ok(Math.abs(estimate.amount - 0.081786) < 1e-12);
    assert.ok(Math.abs(estimate.flatAmount - 0.09849) < 1e-12);
  });

  await test('Claude one-hour cache writes survive upload and price at cacheWrite1h', async () => {
    const pricing = require('../src/core/pricing');
    const expected = pricing.priceTokens('claude-haiku-4-5', {
      in: 10, out: 58, cache_write: 6440, cache_write_5m: 0, cache_write_1h: 6440
    });
    assert.ok(Math.abs(expected.amount - 0.01318) < 1e-12);
    events.append({
      event_id: 'claude-1h-cache-write-roundtrip',
      device_id: deviceA.deviceId,
      harness: 'claude-code',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      pricing_model: 'anthropic/claude-haiku-4.5',
      ts: new Date().toISOString(),
      tokens: {
        in: 10, out: 58, cache_read: 0, cache_write: 6440,
        cache_write_5m: 0, cache_write_1h: 6440
      },
      source: 'local-log'
    });
    await events.flush();
    const pushed = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.strictEqual(pushed.ok, true);
    assert.strictEqual(pushed.sent, 1);
    const row = (await pool.query(
      `SELECT tokens, pricing_amount, pricing_status, pricing_catalogue_version
         FROM usage_events WHERE event_id=$1`,
      ['claude-1h-cache-write-roundtrip']
    )).rows[0];
    assert.strictEqual(Number(row.tokens.cache_write_1h), 6440);
    assert.strictEqual(Number(row.tokens.cache_write_5m), 0);
    assert.strictEqual(Number(row.tokens.cache_write), 6440);
    assert.strictEqual(row.pricing_status, 'priced');
    assert.strictEqual(row.pricing_catalogue_version, 'openrouter-2026-08-03');
    assert.ok(Math.abs(Number(row.pricing_amount) - 0.01318) < 1e-12,
      'postgres stored amount ' + row.pricing_amount);
  });

  await test('network outage keeps a new event queued and recovery delivers it once', async () => {
    events.append({ event_id: 'offline-recovery-event-01', harness: 'pi', provider: 'openai',
      model: 'gpt-5.6-sol', ts: new Date().toISOString(), tokens: { in: 5, out: 5 } });
    await events.flush();
    const offline = await sync.push({ endpoint: 'http://127.0.0.1:1', deviceCredential: deviceA.deviceCredential });
    assert.strictEqual(offline.ok, false); assert.ok(outbox.status().pendingTotal > 0);
    const recovered = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.strictEqual(recovered.ok, true); assert.strictEqual(recovered.sent, 1);
  });

  await test('savepoints isolate control, time-range and database-constraint poison records', async () => {
    const normal = (eventId) => ({
      event_id: eventId, harness: 'codex', provider: 'openai', model: 'gpt-5.6-sol',
      ts: new Date().toISOString(), tokens: { in: 9, out: 1 }, source: 'local-log'
    });
    const cases = [
      { name: 'nul-event-id', marker: 'raw-nul-event-id', mutate: (bad) => { bad.event_id = 'raw-nul-event-id\u0000'; } },
      { name: 'nul-model', marker: 'raw-nul-model', mutate: (bad) => { bad.model = 'raw-nul-model\u0000'; } },
      { name: 'nul-harness', marker: 'raw-nul-harness', mutate: (bad) => { bad.harness = 'raw-nul-harness\u0000'; } },
      { name: 'out-of-range-time', marker: '1900-01-01', mutate: (bad) => { bad.ts = '1900-01-01T00:00:00.000Z'; } },
      { name: 'database-constraint', marker: 'database-constraint-probe', constraint: true,
        mutate: (bad) => { bad.model = 'database-constraint-probe'; } }
    ];
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index];
      const valid = normal('savepoint-valid-event-' + index);
      const bad = normal('savepoint-poison-event-' + index);
      item.mutate(bad);
      if (item.constraint) {
        await pool.query(`ALTER TABLE usage_events ADD CONSTRAINT usage_events_test_rejection
          CHECK (model IS DISTINCT FROM 'database-constraint-probe')`);
      }
      try {
        const response = await request(port, 'POST', '/api/v1/events', { events: [valid, bad] },
          deviceA.deviceCredential);
        assert.strictEqual(response.status, 200, item.name + ' must not return 500');
        assert.deepStrictEqual(response.json.accepted, [valid.event_id]);
        assert.strictEqual(response.json.rejected, 1);
        assert.strictEqual(response.json.permanentlyRejected[0].event_index, 1);
        assert.ok(!response.raw.includes(item.marker), item.name + ' leaked its raw offending value');
        assert.ok(!/constraint|postgres|database detail|violates/i.test(
          response.json.permanentlyRejected[0].reason
        ), item.name + ' leaked database details');

        const replay = await request(port, 'POST', '/api/v1/events', { events: [valid, bad] },
          deviceA.deviceCredential);
        assert.strictEqual(replay.status, 200);
        assert.strictEqual(replay.json.duplicates, 1);
        assert.strictEqual(replay.json.rejected, 1);
        const stored = await pool.query(
          'SELECT count(*) FROM usage_events WHERE company_id=$1 AND event_id=$2',
          [companyA.company.id, valid.event_id]
        );
        assert.strictEqual(Number(stored.rows[0].count), 1, item.name + ' replay inflated usage');
      } finally {
        if (item.constraint) await pool.query(
          'ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_test_rejection'
        );
      }
    }
    const rejections = await pool.query(
      'SELECT event_id,reason FROM usage_rejections WHERE company_id=$1 ORDER BY id DESC LIMIT 10',
      [companyA.company.id]
    );
    const serialized = JSON.stringify(rejections.rows);
    for (const marker of cases.map((item) => item.marker)) {
      assert.ok(!serialized.includes(marker), 'stored rejection leaked raw value: ' + marker);
    }
  });

  await test('desktop quarantines an index-only rejection and continues its outbox', async () => {
    const validId = 'outbox-valid-after-poison-01';
    const poisonId = 'outbox-poison-id\u0000-01';
    events.append({ event_id: validId, harness: 'codex', provider: 'openai',
      model: 'gpt-5.6-sol', ts: new Date().toISOString(), tokens: { in: 9, out: 1 } });
    events.append({ event_id: poisonId, harness: 'codex', provider: 'openai',
      model: 'gpt-5.6-sol', ts: new Date().toISOString(), tokens: { in: 9, out: 1 } });
    await events.flush();
    const first = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.deepStrictEqual(first, { ok: true, sent: 1, rejected: 1, pending: 0, message: undefined });
    const cursor = outbox.loadCursor();
    assert.ok(cursor.rejected.includes(poisonId));
    const second = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.strictEqual(second.sent, 0); assert.strictEqual(second.rejected, 0); assert.strictEqual(second.pending, 0);
    const stored = await pool.query(
      'SELECT count(*) FROM usage_events WHERE company_id=$1 AND event_id=$2',
      [companyA.company.id, validId]
    );
    assert.strictEqual(Number(stored.rows[0].count), 1);

    const unsafe = await request(port, 'POST', '/api/v1/events', { events: [{
      event_id: 'unsafe-integer-event-01', harness: 'codex', provider: 'openai',
      model: 'gpt-5.6-sol', ts: new Date().toISOString(), tokens: { in: Number.MAX_SAFE_INTEGER + 1 }
    }] }, deviceA.deviceCredential);
    assert.strictEqual(unsafe.status, 200); assert.strictEqual(unsafe.json.rejected, 1);
  });

  await test('duplicate replay is acknowledged without increasing totals', async () => {
    const before = Number((await pool.query('SELECT count(*) FROM usage_events WHERE company_id=$1',
      [companyA.company.id])).rows[0].count);
    outbox.saveCursor({ sent: [], rejected: [], lastSyncAt: null, lastError: null, sentTotal: 0, rejectedTotal: 0 });
    const replay = await sync.push({ endpoint, deviceCredential: deviceA.deviceCredential });
    assert.ok(replay.sent >= 2);
    const after = Number((await pool.query('SELECT count(*) FROM usage_events WHERE company_id=$1',
      [companyA.company.id])).rows[0].count);
    assert.strictEqual(after, before);
  });

  await test('two companies may use the same event id and label without collision', async () => {
    const event = { event_id: 'shared-company-event-0001', device_id: 'forged', harness: 'claude-code',
      provider: 'anthropic', model: 'claude-opus-4-8', ts: new Date().toISOString(), tokens: { in: 7, out: 2 } };
    const res = await request(port, 'POST', '/api/v1/events', { device: { id: deviceA.deviceId }, events: [event] },
      deviceB.deviceCredential);
    assert.strictEqual(res.status, 200); assert.strictEqual(res.json.duplicates, 0);
    const count = await pool.query('SELECT count(*) FROM usage_events WHERE event_id=$1', [event.event_id]);
    assert.strictEqual(Number(count.rows[0].count), 2);
  });

  await test('fleet reads are company-scoped and preserve price parity', async () => {
    const a = await request(port, 'GET', '/api/v1/fleet', null, managerA);
    const b = await request(port, 'GET', '/api/v1/fleet', null, managerB);
    assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
    assert.ok(a.json.byDevice[deviceA.deviceId]); assert.ok(!a.json.byDevice[deviceB.deviceId]);
    assert.ok(b.json.byDevice[deviceB.deviceId]); assert.ok(!b.json.byDevice[deviceA.deviceId]);
    const expected = pricing.priceTokens('claude-opus-4-8', { in: 200, out: 50, cache_read: 620, cache_write: 80 });
    const oneHourCache = pricing.priceTokens('claude-haiku-4-5', {
      in: 10, out: 58, cache_write: 6440, cache_write_5m: 0, cache_write_1h: 6440
    });
    assert.ok(
      Math.abs(
        a.json.byHarness['claude-code'].openrouterEquivalent.amount
          - (expected.amount + oneHourCache.amount)
      ) < 1e-12
    );
    assert.ok(a.json.devices.find((d) => d.id === deviceA.deviceId).lastSeenAt);
  });

  await test('cross-company revoke is hidden and own-company revoke stops uploads', async () => {
    const cross = await request(port, 'POST', '/api/v1/manager/devices/' + deviceA.deviceId + '/revoke', {}, managerB);
    assert.strictEqual(cross.status, 404);
    const own = await request(port, 'POST', '/api/v1/manager/devices/' + deviceA.deviceId + '/revoke', {}, managerA);
    assert.strictEqual(own.status, 200);
    const denied = await request(port, 'POST', '/api/v1/events', { events: [] }, deviceA.deviceCredential);
    assert.strictEqual(denied.status, 401);
  });

  await test('expired manager sessions and malformed JSON fail closed', async () => {
    await pool.query('UPDATE manager_sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1',
      [security.tokenHash(managerA)]);
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet', null, managerA)).status, 401);
    const malformed = await login(port, null, null, '{not json');
    assert.strictEqual(malformed.status, 400);
  });

  await test('oversized bodies are rejected before JSON processing', async () => {
    const oversized = JSON.stringify({ email: 'x', password: 'x'.repeat(17 * 1024) });
    const res = await login(port, null, null, oversized);
    assert.strictEqual(res.status, 413);
  });

  await test('login rate limits repeated guessing', async () => {
    let final;
    for (let i = 0; i < 10; i++) final = await login(port, 'nobody@example.test', 'wrong-password-value');
    assert.strictEqual(final.status, 429);
  });

  await test('one-time flat import preserves history as revoked devices', async () => {
    const dataDir = path.join(scratch, 'flat');
    fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'events', '2026-08-03.jsonl'), JSON.stringify({
      event_id: 'historical-event-0001', device_id: 'old-office', device_label: 'old-office',
      harness: 'codex', provider: 'openai', model: 'gpt-5.6-sol', ts: new Date().toISOString(),
      tokens: { in: 4, out: 1 }, source: 'local-log'
    }) + '\n');
    const result = await importFlat(pool, { dataDir, companyId: companyA.company.id });
    assert.deepStrictEqual(result, { imported: 1, duplicates: 0, historicalDevices: 1 });
    const replay = await importFlat(pool, { dataDir, companyId: companyA.company.id });
    assert.deepStrictEqual(replay, { imported: 0, duplicates: 1, historicalDevices: 1 });
    const historical = await pool.query("SELECT credential_hash,revoked_at FROM devices WHERE platform='historical'");
    assert.strictEqual(historical.rows[0].credential_hash, null); assert.ok(historical.rows[0].revoked_at);
  });

  await test('stored rows and normal API bodies contain no raw auth or sensitive content', async () => {
    const dump = JSON.stringify({
      managers: (await pool.query('SELECT email,password_salt,password_hash,password_params FROM managers')).rows,
      sessions: (await pool.query('SELECT token_hash,expires_at FROM manager_sessions')).rows,
      devices: (await pool.query('SELECT id,credential_hash FROM devices')).rows,
      events: (await pool.query('SELECT * FROM usage_events')).rows,
      audit: (await pool.query('SELECT * FROM audit_facts')).rows
    });
    for (const raw of [managerA, managerB, deviceA.deviceCredential, deviceB.deviceCredential,
      'correct horse battery staple', 'another correct horse battery']) assert.ok(!dump.includes(raw));
    for (const word of ['"prompt"','"completion"','"filename"','"path"','"credential"']) {
      assert.ok(!JSON.stringify((await pool.query('SELECT tokens FROM usage_events')).rows).includes(word));
    }
  });

  await new Promise((resolve) => collector.server.close(resolve));
  await pool.end();
  fs.rmSync(scratch, { recursive: true, force: true });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const failure of failures) console.log('\n' + failure.name + '\n' + failure.err.stack);
    process.exit(1);
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
