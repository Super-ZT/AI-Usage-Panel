'use strict';

const assert = require('assert');
const http = require('http');

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL must point to a disposable PostgreSQL database');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const repository = require('../server/repository');
const security = require('../server/security');
const { createCollector } = require('../server/collector');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  FAIL ' + name + '\n       ' + err.message); }
}

function request(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const requestHeaders = Object.assign({}, headers || {});
    if (payload) { requestHeaders['content-type'] = 'application/json'; requestHeaders['content-length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: requestHeaders }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch (_) { /* static asset */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject); if (payload) req.end(payload); else req.end();
  });
}

function firstCookie(response, name) {
  const values = response.headers['set-cookie'] || [];
  const found = values.find((value) => value.startsWith(name + '='));
  return found && found.split(';')[0];
}

async function login(port, email, password) {
  const pre = await request(port, 'GET', '/api/v1/manager/csrf');
  const loginResult = await request(port, 'POST', '/api/v1/manager/login', { email, password }, {
    cookie: firstCookie(pre, 'up_prelogin_csrf'), 'x-csrf-token': pre.json.csrfToken
  });
  return { response: loginResult, cookie: firstCookie(loginResult, 'up_manager'), csrf: loginResult.json && loginResult.json.csrfToken };
}

async function managerPost(port, session, route, body, includeCsrf = true) {
  const headers = { cookie: session.cookie };
  if (includeCsrf) headers['x-csrf-token'] = session.csrf;
  return request(port, 'POST', route, body || {}, headers);
}

async function enroll(port, session, label) {
  const created = await managerPost(port, session, '/api/v1/manager/enrollment-codes', { ttlMinutes: 15 });
  assert.strictEqual(created.status, 201);
  const enrolled = await request(port, 'POST', '/api/v1/enroll', {
    code: created.json.enrollmentCode, label, platform: 'windows'
  });
  assert.strictEqual(enrolled.status, 201);
  return { code: created.json.enrollmentCode, ...enrolled.json };
}

function usage(id, harness, model, ts, tokens) {
  return { event_id: id, harness, provider: 'test', model, pricing_model: model, ts, tokens, source: 'local-log' };
}

(async () => {
  console.log('manager dashboard / PostgreSQL HTTP tests\n');
  const pool = repository.createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await repository.migrate(pool);
  const companyA = await repository.bootstrapCompany(pool, {
    slug: 'dashboard-a', name: 'Dashboard A', email: 'manager-a@example.test', password: 'correct dashboard password a'
  });
  const companyB = await repository.bootstrapCompany(pool, {
    slug: 'dashboard-b', name: 'Dashboard B', email: 'manager-b@example.test', password: 'correct dashboard password b'
  });
  const collector = createCollector({ pool, keepPoolOpen: true });
  await new Promise((resolve) => collector.server.listen(0, '127.0.0.1', resolve));
  const port = collector.server.address().port;
  let a, b, a1, a2, b1;

  await test('rendered assets are local, restrictive, accessible and escape data in script', async () => {
    const html = await request(port, 'GET', '/manager');
    const js = await request(port, 'GET', '/manager/manager.js');
    const css = await request(port, 'GET', '/manager/manager.css');
    assert.strictEqual(html.status, 200); assert.strictEqual(js.status, 200); assert.strictEqual(css.status, 200);
    assert.match(html.headers['content-security-policy'], /default-src 'none'/);
    assert.match(html.headers['content-security-policy'], /script-src 'self'/);
    assert.ok(!/https?:\/\//.test(html.raw), 'dashboard must not load a CDN');
    assert.match(html.raw, /<main/); assert.match(html.raw, /<label/); assert.match(html.raw, /aria-live/);
    assert.match(js.raw, /textContent/); assert.ok(!/innerHTML|localStorage|sessionStorage/.test(js.raw));
    assert.match(js.raw, /computers may upload later/);
    assert.match(html.raw, /Read-only usage view/);
    assert.ok(!/id="(?:new-code|copy-code|enrollment)"/.test(html.raw));
    assert.ok(!/\/api\/v1\/manager\/enrollment-codes|\/revoke/.test(js.raw));
    assert.ok(!/window\.confirm/.test(js.raw));
    assert.match(css.raw, /:focus-visible/); assert.match(css.raw, /@media/);
    assert.match(css.raw, /gap:8px 14px/); assert.match(css.raw, /minmax\(0,1fr\)/);
  });

  await test('portal usage-panel route serves the manager page and assets', async () => {
    const html = await request(port, 'GET', '/portal/usage-panel');
    const slash = await request(port, 'GET', '/portal/usage-panel/');
    const js = await request(port, 'GET', '/portal/usage-panel/manager.js');
    const css = await request(port, 'GET', '/portal/usage-panel/manager.css');
    assert.strictEqual(html.status, 200); assert.strictEqual(slash.status, 200);
    assert.strictEqual(js.status, 200); assert.strictEqual(css.status, 200);
    assert.match(html.raw, /OpenRouter-equivalent estimate/);
    assert.ok(!/\b(charged|billed|subscription cost|provider cost)\b/i.test(html.raw),
      'portal HTML must not claim charged/billed/subscription/provider cost');
    assert.ok(!/\b(charged|billed|subscription cost|provider cost)\b/i.test(js.raw),
      'portal JS must not claim charged/billed/subscription/provider cost');
    assert.match(js.raw, /OpenRouter-equivalent estimate/);
    assert.match(js.raw, /task counters/);
    assert.match(html.raw, /Account-window figures stay separate from task rows/);
    assert.match(js.raw, /['"]local['"]/);
    // Must not instruct the UI that device-uploaded Cursor rows are already provider-accounted.
    assert.ok(!/matchedProviderEvents/.test(js.raw));
  });

  await test('login requires pre-login CSRF and returns a hardened cookie with no session in JSON', async () => {
    const denied = await request(port, 'POST', '/api/v1/manager/login', {
      email: 'manager-a@example.test', password: 'correct dashboard password a'
    });
    assert.strictEqual(denied.status, 403); assert.deepStrictEqual(denied.json, { error: 'request rejected' });
    a = await login(port, 'manager-a@example.test', 'correct dashboard password a');
    b = await login(port, 'manager-b@example.test', 'correct dashboard password b');
    assert.strictEqual(a.response.status, 200); assert.strictEqual(b.response.status, 200);
    const cookie = a.response.headers['set-cookie'].find((value) => value.startsWith('up_manager='));
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    assert.ok(!/upm_/.test(JSON.stringify(a.response.json))); assert.match(a.csrf, /^upc_/);
  });

  await test('unknown accounts and wrong passwords return the same generic failure', async () => {
    const unknown = await login(port, 'unknown@example.test', 'some incorrect password');
    const wrong = await login(port, 'manager-a@example.test', 'some incorrect password');
    assert.strictEqual(unknown.response.status, 401); assert.strictEqual(wrong.response.status, 401);
    assert.strictEqual(unknown.response.raw, wrong.response.raw);
  });

  await test('session resume rotates a hash-only CSRF token without exposing the session', async () => {
    const previous = a.csrf;
    const resumed = await request(port, 'GET', '/api/v1/manager/session', null, { cookie: a.cookie });
    assert.strictEqual(resumed.status, 200); assert.match(resumed.json.csrfToken, /^upc_/);
    assert.notStrictEqual(resumed.json.csrfToken, previous); assert.ok(!/upm_/.test(resumed.raw));
    a.csrf = resumed.json.csrfToken;
    const stored = (await pool.query('SELECT token_hash,csrf_hash FROM manager_sessions WHERE manager_id=$1',
      [companyA.manager.id])).rows;
    assert.ok(stored.every((row) => Buffer.isBuffer(row.token_hash) && Buffer.isBuffer(row.csrf_hash)));
    assert.ok(!JSON.stringify(stored).includes(a.csrf));
  });

  await test('state-changing manager routes deny missing CSRF', async () => {
    const deniedCode = await managerPost(port, a, '/api/v1/manager/enrollment-codes', { ttlMinutes: 15 }, false);
    assert.strictEqual(deniedCode.status, 403); assert.deepStrictEqual(deniedCode.json, { error: 'request rejected' });
    const deniedLogout = await managerPost(port, a, '/api/v1/manager/logout', {}, false);
    assert.strictEqual(deniedLogout.status, 403);
  });

  await test('one-use enrollment and duplicate labels remain distinct immutable devices', async () => {
    a1 = await enroll(port, a, '<img src=x onerror=alert(1)>');
    a2 = await enroll(port, a, '<img src=x onerror=alert(1)>');
    b1 = await enroll(port, b, '<img src=x onerror=alert(1)>');
    assert.notStrictEqual(a1.deviceId, a2.deviceId); assert.notStrictEqual(a1.deviceId, b1.deviceId);
    const replay = await request(port, 'POST', '/api/v1/enroll', {
      code: a1.code, label: 'replay', platform: 'windows'
    });
    assert.strictEqual(replay.status, 401);
  });

  await test('real upload produces honest totals, unknown pricing and stale presence', async () => {
    const now = new Date(); const old = new Date(Date.now() - 40 * 86400000);
    const uploaded = await request(port, 'POST', '/api/v1/events', { events: [
      usage('dashboard-known-event-01', 'claude-code', 'anthropic/claude-opus-4.6', now.toISOString(),
        { in: 100, out: 20, cache_read: 30, cache_write: 5 }),
      usage('dashboard-unknown-event-1', 'mystery-tool', 'does-not-exist/model', now.toISOString(),
        { in: 7, out: 3 }),
      usage('dashboard-old-event-0001', 'codex', 'openai/gpt-5.2', old.toISOString(), { in: 999, out: 1 })
    ] }, { authorization: 'Bearer ' + a1.deviceCredential });
    assert.strictEqual(uploaded.status, 200); assert.strictEqual(uploaded.json.accepted.length, 3);
    await pool.query("UPDATE devices SET last_seen_at=now()-interval '10 minutes' WHERE id=$1", [a1.deviceId]);
    const fleet = await request(port, 'GET', '/api/v1/fleet?days=30', null, { cookie: a.cookie });
    assert.strictEqual(fleet.status, 200); assert.strictEqual(fleet.json.totalEvents, 2);
    assert.deepStrictEqual(fleet.json.total.tokens, { in: 107, out: 23, cache_read: 30, cache_write: 5, reasoning: 0, unattributed: 0 });
    assert.strictEqual(fleet.json.total.openrouterEquivalent.status, 'partial');
    assert.deepStrictEqual(fleet.json.total.openrouterEquivalent.unpricedModels, ['does-not-exist/model']);
    assert.strictEqual(fleet.json.devices.find((device) => device.id === a1.deviceId).online, false);
  });

  await test('date, tool and device filters use real company-scoped SQL', async () => {
    const tool = await request(port, 'GET', '/api/v1/fleet?days=30&tool=claude-code', null, { cookie: a.cookie });
    assert.strictEqual(tool.json.totalEvents, 1); assert.deepStrictEqual(Object.keys(tool.json.byHarness), ['claude-code']);
    const device = await request(port, 'GET', '/api/v1/fleet?days=30&device=' + a2.deviceId, null, { cookie: a.cookie });
    assert.strictEqual(device.json.totalEvents, 0);
    const year = await request(port, 'GET', '/api/v1/fleet?days=365&tool=codex', null, { cookie: a.cookie });
    assert.strictEqual(year.json.totalEvents, 1); assert.strictEqual(year.json.total.tokens.in, 999);
  });

  await test('company tampering cannot expose or mutate another company', async () => {
    const fleet = await request(port, 'GET', '/api/v1/fleet?days=365&companyId=' + companyB.company.id,
      null, { cookie: a.cookie });
    assert.ok(fleet.json.devices.some((device) => device.id === a1.deviceId));
    assert.ok(!fleet.json.devices.some((device) => device.id === b1.deviceId));
    const filtered = await request(port, 'GET', '/api/v1/fleet?device=' + b1.deviceId, null, { cookie: a.cookie });
    assert.strictEqual(filtered.json.totalEvents, 0); assert.ok(!filtered.json.byDevice[b1.deviceId]);
    const revoke = await managerPost(port, a, '/api/v1/manager/devices/' + b1.deviceId + '/revoke', {
      companyId: companyB.company.id
    });
    assert.strictEqual(revoke.status, 404);
  });

  await test('escaped labels are returned as data and no secrets or hashes enter manager bodies', async () => {
    const fleet = await request(port, 'GET', '/api/v1/fleet', null, { cookie: a.cookie });
    assert.ok(fleet.json.devices.some((device) => device.label === '<img src=x onerror=alert(1)>'));
    assert.ok(!/credential_hash|token_hash|password_hash|upm_|upd_/.test(fleet.raw));
    const html = await request(port, 'GET', '/manager');
    assert.ok(!html.raw.includes('<img src=x onerror=alert(1)>'));
  });

  await test('revocation needs confirmation-path CSRF and stops upload-only credentials', async () => {
    const revoked = await managerPost(port, a, '/api/v1/manager/devices/' + a2.deviceId + '/revoke', {});
    assert.strictEqual(revoked.status, 200);
    const upload = await request(port, 'POST', '/api/v1/events', { events: [] }, {
      authorization: 'Bearer ' + a2.deviceCredential
    });
    assert.strictEqual(upload.status, 401);
  });

  await test('anonymous, device, expired and oversized browser requests fail closed', async () => {
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet')).status, 401);
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet', null, {
      authorization: 'Bearer ' + b1.deviceCredential
    })).status, 403);
    const rawA = decodeURIComponent(a.cookie.slice('up_manager='.length));
    await pool.query("UPDATE manager_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [security.tokenHash(rawA)]);
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet', null, { cookie: a.cookie })).status, 401);
    const pre = await request(port, 'GET', '/api/v1/manager/csrf');
    const oversized = await request(port, 'POST', '/api/v1/manager/login', JSON.stringify({
      email: 'x', password: 'x'.repeat(17 * 1024)
    }), { cookie: firstCookie(pre, 'up_prelogin_csrf'), 'x-csrf-token': pre.json.csrfToken });
    assert.strictEqual(oversized.status, 413);
  });

  await test('logout revokes the real session and clears its cookie', async () => {
    const loggedOut = await managerPost(port, b, '/api/v1/manager/logout', {});
    assert.strictEqual(loggedOut.status, 200); assert.deepStrictEqual(loggedOut.json, { loggedOut: true });
    assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0/);
    assert.strictEqual((await request(port, 'GET', '/api/v1/fleet', null, { cookie: b.cookie })).status, 401);
  });

  // Re-login A after the earlier session-expiry test for accuracy-contract checks.
  a = await login(port, 'manager-a@example.test', 'correct dashboard password a');
  assert.strictEqual(a.response.status, 200);

  await test('accuracy contract: cache-write 1h pricing, byModel, unknown never zero, sources preserved', async () => {
    const pricing = require('../src/core/pricing');
    const now = new Date().toISOString();
    const staged = {
      in: 10, out: 58, cache_read: 0, cache_write: 6440,
      cache_write_5m: 0, cache_write_1h: 6440, cache_write_unresolved: 0
    };
    const expected = pricing.priceTokens('claude-haiku-4-5', staged);
    assert.strictEqual(expected.status, 'priced');
    assert.ok(Math.abs(expected.amount - 0.01318) < 1e-12, 'got ' + expected.amount);

    const uploaded = await request(port, 'POST', '/api/v1/events', { events: [
      {
        event_id: 'accuracy-cache-1h-haiku-01',
        harness: 'claude-code',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        pricing_model: 'claude-haiku-4-5',
        ts: now,
        tokens: staged,
        source: 'local_log'
      },
      {
        event_id: 'accuracy-unknown-model-02',
        harness: 'cursor',
        provider: 'cursor',
        model: 'totally-missing/model-xyz',
        ts: now,
        tokens: { in: 11, out: 2 },
        source: 'official_api'
      },
      {
        event_id: 'accuracy-grok-local-03',
        harness: 'grok-build',
        provider: 'xai',
        model: 'grok-4.5',
        ts: now,
        tokens: { unattributed: 1000 },
        source: 'local_log'
      },
      {
        event_id: 'accuracy-partial-unresolved-04',
        harness: 'claude-code',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        ts: now,
        tokens: {
          in: 0, out: 0, cache_write: 100, cache_write_1h: 100, cache_write_unresolved: 50
        },
        source: 'local_log'
      }
    ] }, { authorization: 'Bearer ' + a1.deviceCredential });
    assert.strictEqual(uploaded.status, 200);
    assert.strictEqual(uploaded.json.accepted.length, 4);

    const fleet = await request(port, 'GET', '/api/v1/fleet?days=30&tool=claude-code', null, {
      cookie: a.cookie
    });
    assert.strictEqual(fleet.status, 200);
    assert.strictEqual(fleet.json.moneyLabel, 'OpenRouter-equivalent estimate');
    assert.strictEqual(fleet.json.pricing.label, 'OpenRouter-equivalent estimate');
    assert.strictEqual(fleet.json.total.openrouterEquivalent.label, 'OpenRouter-equivalent estimate');
    assert.match(fleet.json.pricing.version, /^openrouter-/);

    const haiku = fleet.json.byModel['claude-haiku-4-5'];
    assert.ok(haiku, 'byModel must include uploaded model key');
    assert.strictEqual(haiku.tokens.in, 10);
    assert.strictEqual(haiku.tokens.out, 58);
    assert.strictEqual(haiku.tokens.cache_write, 6540);
    assert.ok(haiku.sources.includes('local_log'));
    // 1h priced row + partial unresolved row → aggregate partial; amount excludes only unknown, keeps partial money
    assert.ok(haiku.openrouterEquivalent.status === 'partial' || haiku.openrouterEquivalent.status === 'priced');
    assert.notStrictEqual(haiku.openrouterEquivalent.amount, 0);
    assert.ok(haiku.openrouterEquivalent.amount > 0.013);
    assert.strictEqual(haiku.openrouterEquivalent.version, pricing.snapshot.version);
    assert.strictEqual(haiku.evidence.tokenDetail, 'exact');
    assert.strictEqual(haiku.evidence.modelIdentity, 'exact');
    assert.strictEqual(haiku.evidence.providerEventReconciliation, 'unknown');
    assert.strictEqual(haiku.evidence.accountWindow, 'unknown');

    const tool = fleet.json.byHarness['claude-code'];
    assert.strictEqual(tool.reporting.label, 'task counters');
    assert.match(tool.reporting.note, /Account-window figures/);

    const full = await request(port, 'GET', '/api/v1/fleet?days=30', null, { cookie: a.cookie });
    assert.strictEqual(full.status, 200);
    assert.ok(full.json.byModel['totally-missing/model-xyz']);
    assert.strictEqual(full.json.byModel['totally-missing/model-xyz'].openrouterEquivalent.status, 'unknown');
    assert.strictEqual(full.json.byModel['totally-missing/model-xyz'].openrouterEquivalent.amount, null);
    assert.ok(Object.values(full.json.byModel).every((bucket) =>
      bucket.evidence.providerEventReconciliation === 'unknown'
        && bucket.evidence.accountWindow === 'unknown'
    ));
    assert.ok(full.json.bySource.local_log);
    assert.ok(full.json.bySource.official_api);
    // Client-supplied harness/source must never yield provider-accounted usage.
    assert.strictEqual(full.json.byHarness.cursor.reporting.label, 'task counters');
    assert.notStrictEqual(full.json.byHarness.cursor.reporting.kind, 'provider-accounted');
    assert.strictEqual(full.json.byHarness['grok-build'].reporting.label, 'local');
    assert.strictEqual(full.json.reportingSurfaces.cursor.uploadedRows, 'task counters');
    assert.match(full.json.reportingSurfaces.cursor.providerAccounted, /not available/);
    assert.strictEqual(full.json.reportingSurfaces.grok.counters, 'local');
    assert.strictEqual(full.json.reportingSurfaces.claude.accountWindow, 'separate from task rows');

    // Wording: never claim charged/billed/subscription cost/provider cost in manager response
    assert.ok(!/\bcharged\b/i.test(full.raw));
    assert.ok(!/\bbilled\b/i.test(full.raw));
    assert.ok(!/subscription cost/i.test(full.raw));
    assert.ok(!/provider cost/i.test(full.raw));
    assert.match(full.raw, /OpenRouter-equivalent estimate/);

    // Aggregate parity: sum of byModel token buckets equals company total for filtered device fleet window
    let sumIn = 0; let sumOut = 0; let sumRead = 0; let sumWrite = 0;
    for (const bucket of Object.values(full.json.byModel)) {
      sumIn += bucket.tokens.in;
      sumOut += bucket.tokens.out;
      sumRead += bucket.tokens.cache_read;
      sumWrite += bucket.tokens.cache_write;
    }
    assert.strictEqual(sumIn, full.json.total.tokens.in);
    assert.strictEqual(sumOut, full.json.total.tokens.out);
    assert.strictEqual(sumRead, full.json.total.tokens.cache_read);
    assert.strictEqual(sumWrite, full.json.total.tokens.cache_write);

    // Stored event preserves original source and catalogue version (no silent rewrite)
    const stored = await pool.query(
      `SELECT event_id, source, pricing_status, pricing_amount, pricing_catalogue_version, tokens
         FROM usage_events WHERE company_id=$1 AND event_id = ANY($2::text[])
         ORDER BY event_id`,
      [companyA.company.id, [
        'accuracy-cache-1h-haiku-01',
        'accuracy-unknown-model-02',
        'accuracy-partial-unresolved-04'
      ]]
    );
    assert.strictEqual(stored.rowCount, 3);
    const byId = Object.fromEntries(stored.rows.map((row) => [row.event_id, row]));
    assert.strictEqual(byId['accuracy-cache-1h-haiku-01'].source, 'local_log');
    assert.strictEqual(byId['accuracy-cache-1h-haiku-01'].pricing_status, 'priced');
    assert.ok(Math.abs(Number(byId['accuracy-cache-1h-haiku-01'].pricing_amount) - 0.01318) < 1e-12);
    assert.strictEqual(byId['accuracy-cache-1h-haiku-01'].pricing_catalogue_version, pricing.snapshot.version);
    assert.strictEqual(Number(byId['accuracy-cache-1h-haiku-01'].tokens.cache_write_1h), 6440);
    assert.strictEqual(byId['accuracy-unknown-model-02'].pricing_status, 'unknown');
    assert.strictEqual(byId['accuracy-unknown-model-02'].pricing_amount, null);
    assert.strictEqual(byId['accuracy-partial-unresolved-04'].pricing_status, 'partial');
  });

  await test('accuracy contract: company-scoped queries and no secret/private identifier leakage', async () => {
    const aFleet = await request(port, 'GET', '/api/v1/fleet?days=365', null, { cookie: a.cookie });
    const bLogin = await login(port, 'manager-b@example.test', 'correct dashboard password b');
    assert.strictEqual(bLogin.response.status, 200);
    const bFleet = await request(port, 'GET', '/api/v1/fleet?days=365', null, { cookie: bLogin.cookie });
    assert.strictEqual(aFleet.status, 200); assert.strictEqual(bFleet.status, 200);
    assert.ok(aFleet.json.devices.some((device) => device.id === a1.deviceId));
    assert.ok(!aFleet.json.devices.some((device) => device.id === b1.deviceId));
    assert.ok(bFleet.json.devices.some((device) => device.id === b1.deviceId));
    assert.ok(!bFleet.json.devices.some((device) => device.id === a1.deviceId));
    assert.ok(!bFleet.json.byDevice[a1.deviceId]);
    assert.ok(!Object.keys(bFleet.json.byModel || {}).some((model) =>
      aFleet.json.byModel[model] && aFleet.json.byModel[model].tokens.cache_write === 6540
      && bFleet.json.total.tokens.cache_write === 0));

    // Direct device probe for the other company returns empty facts, not filtered leakage.
    const probe = await request(port, 'GET', '/api/v1/fleet?device=' + b1.deviceId, null, {
      cookie: a.cookie
    });
    assert.strictEqual(probe.json.totalEvents, 0);
    assert.strictEqual(probe.json.total.evidence.modelIdentity, 'unknown');
    assert.strictEqual(probe.json.total.evidence.providerEventReconciliation, 'unknown');
    assert.strictEqual(probe.json.total.evidence.accountWindow, 'unknown');
    assert.deepStrictEqual(probe.json.byDevice, {});
    assert.deepStrictEqual(probe.json.byModel, {});

    // Secrets and private ids must not appear in manager bodies.
    const forbidden = /credential_hash|token_hash|password_hash|\bupm_|\bupd_|conversation[_-]?id|account[_-]?id|oauth|api[_-]?key|BEGIN (RSA |OPENSSH )?PRIVATE|client_secret/i;
    assert.ok(!forbidden.test(aFleet.raw), 'manager fleet must not leak secrets or private identifiers');
    assert.ok(!forbidden.test(bFleet.raw));
    const portal = await request(port, 'GET', '/portal/usage-panel');
    assert.ok(!forbidden.test(portal.raw));
    assert.ok(!/"conversationId"|\"accountId\"|\"providerAccountId\"/.test(aFleet.raw));
  });

  await test('provenance attack: fabricated cursor official-api upload is never provider-accounted', async () => {
    const now = new Date().toISOString();
    const attack = await request(port, 'POST', '/api/v1/events', { events: [
      {
        event_id: 'fabricated-provenance-0001',
        harness: 'cursor-agent',
        provider: 'cursor',
        model: 'default',
        ts: now,
        tokens: { in: 999999, out: 888888 },
        source: 'official-api',
        // Client-side verification claims must be ignored if present.
        provider_verified: true,
        providerVerified: true,
        reporting: { kind: 'provider-accounted', label: 'provider-accounted usage' }
      },
      {
        event_id: 'fabricated-provenance-mix-02',
        harness: 'cursor-agent',
        provider: 'cursor',
        model: 'default',
        ts: now,
        tokens: { in: 1, out: 1 },
        source: 'local_log'
      }
    ] }, { authorization: 'Bearer ' + a1.deviceCredential });
    assert.strictEqual(attack.status, 200);
    assert.strictEqual(attack.json.accepted.length, 2);

    const fleet = await request(port, 'GET', '/api/v1/fleet?days=30&tool=cursor-agent', null, {
      cookie: a.cookie
    });
    assert.strictEqual(fleet.status, 200);
    const harness = fleet.json.byHarness['cursor-agent'];
    assert.ok(harness, 'fabricated harness row is visible as task data');
    assert.strictEqual(harness.tokens.in, 1000000);
    assert.strictEqual(harness.tokens.out, 888889);
    assert.strictEqual(harness.reporting.kind, 'task-row');
    assert.strictEqual(harness.reporting.label, 'task counters');
    // kind/label themselves must not assert verification (notes may mention the phrase as denied).
    assert.notStrictEqual(harness.reporting.kind, 'provider-accounted');
    assert.notStrictEqual(harness.reporting.label, 'provider-accounted usage');
    assert.ok(!/"kind":"provider-accounted"/.test(fleet.raw));
    assert.ok(!/"label":"provider-accounted usage"/.test(fleet.raw),
      'fleet response must not label fabricated upload as provider-accounted usage');

    // Multi-source aggregate for the same harness must not upgrade to verified either.
    assert.ok(Array.isArray(harness.sources));
    assert.ok(harness.sources.some((s) => /official/i.test(s)));
    assert.ok(harness.sources.some((s) => /local/i.test(s)));
    assert.notStrictEqual(harness.reporting.kind, 'provider-accounted');

    // Source key is whatever was stored; accept either hyphen or underscore form.
    const sourceBucket = fleet.json.bySource['official-api']
      || fleet.json.bySource['official_api']
      || Object.entries(fleet.json.bySource).find(([k]) => /official/i.test(k))?.[1];
    assert.ok(sourceBucket, 'official-api source bucket present');
    assert.notStrictEqual(sourceBucket.reporting.kind, 'provider-accounted');
    assert.notStrictEqual(sourceBucket.reporting.label, 'provider-accounted usage');
    assert.ok(sourceBucket.reporting.label === 'task counters' || sourceBucket.reporting.label === 'local');
  });

  await new Promise((resolve) => collector.server.close(resolve));
  await pool.end();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const failure of failures) console.log('\n' + failure.name + '\n' + failure.err.stack);
    process.exit(1);
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
