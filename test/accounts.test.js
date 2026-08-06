'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL must point to a disposable PostgreSQL database');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const repository = require('../server/repository');
const security = require('../server/security');
const { createCollector } = require('../server/collector');

const RATE_LIMIT_SECRET = 'account-test-rate-limit-secret';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  FAIL ' + name + '\n       ' + err.message); }
}

function request(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const requestHeaders = Object.assign({}, headers || {});
    if (payload) { requestHeaders['content-type'] = 'application/json'; requestHeaders['content-length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: requestHeaders }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch (_) { /* no JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject); if (payload) req.end(payload); else req.end();
  });
}

function cookie(response, name) {
  const found = (response.headers['set-cookie'] || []).find((value) => value.startsWith(name + '='));
  return found && found.split(';')[0];
}

async function accountLogin(port, email, password) {
  const pre = await request(port, 'GET', '/api/v1/account/csrf');
  const response = await request(port, 'POST', '/api/v1/account/login', { email, password }, {
    cookie: cookie(pre, 'up_account_prelogin_csrf'), 'x-csrf-token': pre.json.csrfToken
  });
  return { response, cookie: cookie(response, 'up_user'), csrf: response.json && response.json.csrfToken };
}

async function managerLogin(port, email, password) {
  const pre = await request(port, 'GET', '/api/v1/manager/csrf');
  const response = await request(port, 'POST', '/api/v1/manager/login', { email, password }, {
    cookie: cookie(pre, 'up_prelogin_csrf'), 'x-csrf-token': pre.json.csrfToken
  });
  return { response, cookie: cookie(response, 'up_manager'), csrf: response.json && response.json.csrfToken };
}

function accountRequest(port, session, method, route, body) {
  const headers = { cookie: session.cookie };
  if (method === 'POST') headers['x-csrf-token'] = session.csrf;
  return request(port, method, route, body, headers);
}

function managerRequest(port, session, method, route, body) {
  const headers = { cookie: session.cookie };
  if (method === 'POST') headers['x-csrf-token'] = session.csrf;
  return request(port, method, route, body, headers);
}

async function enroll(port, session, label, companyId) {
  const created = await accountRequest(port, session, 'POST', '/api/v1/account/enrollment-codes', {
    companyId, ttlMinutes: 15
  });
  assert.strictEqual(created.status, 201);
  const enrolled = await request(port, 'POST', '/api/v1/enroll', {
    code: created.json.enrollmentCode, label, platform: 'test'
  });
  assert.strictEqual(enrolled.status, 201);
  return enrolled.json;
}

function usage(id, tokens) {
  return {
    event_id: id, device_id: 'forged-device', companyId: 'forged-company', userId: 'forged-user',
    harness: 'claude-code', provider: 'anthropic', model: 'anthropic/claude-haiku-4.5',
    pricing_model: 'anthropic/claude-haiku-4.5', ts: new Date().toISOString(),
    tokens, source: 'local-log'
  };
}

(async () => {
  console.log('end-user accounts / PostgreSQL HTTP tests\n');
  const pool = repository.createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const migrations = await repository.migrate(pool);
  const createOutsider = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'server', 'admin.js'), 'create-user', '--email', 'outsider@example.test'
  ], { input: 'outsider account password\n', encoding: 'utf8', env: process.env, timeout: 10000 });
  if (createOutsider.status !== 0) {
    const detail = typeof createOutsider.stderr === 'string' && createOutsider.stderr.trim()
      ? createOutsider.stderr.trim()
      : (createOutsider.error && createOutsider.error.message) || 'no process error output';
    throw new Error('create-user command failed: ' + detail);
  }
  const companyA = await repository.bootstrapCompany(pool, {
    slug: 'accounts-a', name: 'Accounts A', email: 'owner-a@example.test', password: 'owner a account password'
  });
  const companyB = await repository.bootstrapCompany(pool, {
    slug: 'accounts-b', name: 'Accounts B', email: 'owner-b@example.test', password: 'owner b account password'
  });
  const member = await repository.createUser(pool, {
    email: 'member@example.test', password: 'member account password'
  });
  const administrator = await repository.createUser(pool, {
    email: 'administrator@example.test', password: 'administrator account password'
  });
  const outsider = (await pool.query(
    "SELECT id,email FROM users WHERE lower(email)='outsider@example.test'"
  )).rows[0];
  const collector = createCollector({ pool, keepPoolOpen: true, rateLimitSecret: RATE_LIMIT_SECRET });
  await new Promise((resolve) => collector.server.listen(0, '127.0.0.1', resolve));
  const port = collector.server.address().port;
  let ownerA, ownerB, memberSession, administratorSession, outsiderSession;
  let managerA, managerB, personalOne, personalTwo, teamA, teamB;

  await test('forward migration creates users, memberships, optional device scope and user sessions', async () => {
    assert.strictEqual(migrations.at(-1), '007_pricing_catalogue_index.sql');
    const columns = await pool.query(
      `SELECT table_name,column_name,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('devices','usage_events','users','company_memberships','user_sessions')`
    );
    assert.ok(columns.rows.some((row) => row.table_name === 'devices' && row.column_name === 'company_id' && row.is_nullable === 'YES'));
    assert.ok(columns.rows.some((row) => row.table_name === 'devices' && row.column_name === 'owner_user_id' && row.is_nullable === 'NO'));
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM users')).rows[0].count), 5);
    assert.strictEqual(Number((await pool.query("SELECT count(*) FROM company_memberships WHERE role='owner' AND revoked_at IS NULL")).rows[0].count), 2);
  });

  await test('each person authenticates once and account failures remain generic and CSRF-protected', async () => {
    const denied = await request(port, 'POST', '/api/v1/account/login', {
      email: 'member@example.test', password: 'member account password'
    });
    assert.strictEqual(denied.status, 403);
    ownerA = await accountLogin(port, 'owner-a@example.test', 'owner a account password');
    ownerB = await accountLogin(port, 'owner-b@example.test', 'owner b account password');
    memberSession = await accountLogin(port, 'member@example.test', 'member account password');
    administratorSession = await accountLogin(port, 'administrator@example.test', 'administrator account password');
    outsiderSession = await accountLogin(port, 'outsider@example.test', 'outsider account password');
    for (const session of [ownerA, ownerB, memberSession, administratorSession, outsiderSession]) {
      assert.strictEqual(session.response.status, 200); assert.match(session.cookie, /^up_user=/); assert.match(session.csrf, /^upc_/);
      assert.ok(!/upu_/.test(session.response.raw));
      const hardened = session.response.headers['set-cookie'].find((value) => value.startsWith('up_user='));
      assert.match(hardened, /HttpOnly/); assert.match(hardened, /Secure/); assert.match(hardened, /SameSite=Strict/);
    }
    const unknown = await accountLogin(port, 'unknown@example.test', 'incorrect account password');
    const wrong = await accountLogin(port, 'member@example.test', 'incorrect account password');
    assert.strictEqual(unknown.response.status, 401); assert.strictEqual(wrong.response.status, 401);
    assert.strictEqual(unknown.response.raw, wrong.response.raw);
    const resumed = await accountRequest(port, memberSession, 'GET', '/api/v1/account/session');
    assert.strictEqual(resumed.status, 200); assert.match(resumed.json.csrfToken, /^upc_/);
    assert.notStrictEqual(resumed.json.csrfToken, memberSession.csrf); memberSession.csrf = resumed.json.csrfToken;
    const stored = await pool.query('SELECT token_hash,csrf_hash FROM user_sessions WHERE user_id=$1', [member.id]);
    assert.ok(stored.rows.every((row) => Buffer.isBuffer(row.token_hash) && Buffer.isBuffer(row.csrf_hash)));
    assert.ok(!JSON.stringify(stored.rows).includes(memberSession.csrf));
  });

  await test('an owner assigns owner, administrator and member roles across two companies', async () => {
    const adminA = await accountRequest(port, ownerA, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members', {
        userId: administrator.id, role: 'administrator'
      });
    const memberA = await accountRequest(port, ownerA, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members', { userId: member.id, role: 'member' });
    const memberB = await accountRequest(port, ownerB, 'POST',
      '/api/v1/account/workspaces/' + companyB.company.id + '/members', { email: member.email, role: 'member' });
    assert.strictEqual(adminA.status, 201); assert.strictEqual(adminA.json.role, 'administrator');
    assert.strictEqual(memberA.status, 201); assert.strictEqual(memberB.status, 201);
    const workspaces = await accountRequest(port, memberSession, 'GET', '/api/v1/account/workspaces');
    assert.deepStrictEqual(new Set(workspaces.json.workspaces.map((row) => row.companyId)),
      new Set([companyA.company.id, companyB.company.id]));
    const wrongRole = await accountRequest(port, memberSession, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members', { userId: outsider.id, role: 'member' });
    assert.strictEqual(wrongRole.status, 404);
    const demoteOwner = await accountRequest(port, ownerA, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members', {
        userId: companyA.user.id, role: 'member'
      });
    assert.strictEqual(demoteOwner.status, 404);
  });

  await test('one user owns several personal and team devices and credentials set the database scope', async () => {
    personalOne = await enroll(port, memberSession, 'personal-one', null);
    personalTwo = await enroll(port, memberSession, 'personal-two', null);
    teamA = await enroll(port, memberSession, 'team-a', companyA.company.id);
    teamB = await enroll(port, memberSession, 'team-b', companyB.company.id);
    assert.strictEqual(new Set([personalOne.deviceId, personalTwo.deviceId, teamA.deviceId, teamB.deviceId]).size, 4);
    for (const [device, id, amount] of [
      [personalOne, 'personal-event-0001', 10], [personalTwo, 'personal-event-0002', 20],
      [teamA, 'shared-team-event-01', 30], [teamB, 'shared-team-event-01', 40]
    ]) {
      const uploaded = await request(port, 'POST', '/api/v1/events', { events: [usage(id, { in: amount, out: 1 })] }, {
        authorization: 'Bearer ' + device.deviceCredential
      });
      assert.strictEqual(uploaded.status, 200); assert.strictEqual(uploaded.json.accepted.length, 1);
    }
    const stored = await pool.query(
      `SELECT d.id,d.owner_user_id,d.company_id,e.owner_user_id AS event_owner,e.company_id AS event_company
         FROM devices d JOIN usage_events e ON e.device_id=d.id WHERE d.owner_user_id=$1`, [member.id]
    );
    assert.strictEqual(stored.rowCount, 4);
    assert.ok(stored.rows.every((row) => row.owner_user_id === member.id && row.event_owner === member.id));
    assert.strictEqual(stored.rows.filter((row) => row.company_id === null && row.event_company === null).length, 2);
    const rejected = await request(port, 'POST', '/api/v1/events', { events: [{
      event_id: 'personal-rejection-01', harness: 'claude-code', provider: 'anthropic',
      model: 'anthropic/claude-haiku-4.5', ts: new Date().toISOString(), tokens: {}
    }] }, { authorization: 'Bearer ' + personalOne.deviceCredential });
    assert.strictEqual(rejected.status, 200); assert.strictEqual(rejected.json.rejected, 1);
    const rejection = (await pool.query(
      `SELECT company_id,owner_user_id,device_id,reason FROM usage_rejections
        WHERE device_id=$1 ORDER BY id DESC LIMIT 1`, [personalOne.deviceId]
    )).rows[0];
    assert.strictEqual(rejection.company_id, null); assert.strictEqual(rejection.owner_user_id, member.id);
    assert.strictEqual(rejection.device_id, personalOne.deviceId); assert.strictEqual(rejection.reason, 'no token usage reported');
  });

  await test('personal and team views are enforced by owner and active membership in SQL', async () => {
    const personal = await accountRequest(port, memberSession, 'GET', '/api/v1/account/fleet?days=30&userId=' + outsider.id);
    const a = await accountRequest(port, memberSession, 'GET', '/api/v1/account/fleet?days=30&companyId=' + companyA.company.id);
    const b = await accountRequest(port, memberSession, 'GET', '/api/v1/account/fleet?days=30&companyId=' + companyB.company.id);
    assert.strictEqual(personal.status, 200); assert.strictEqual(personal.json.totalEvents, 2);
    assert.deepStrictEqual(new Set(personal.json.devices.map((row) => row.id)), new Set([personalOne.deviceId, personalTwo.deviceId]));
    assert.strictEqual(a.json.totalEvents, 1); assert.deepStrictEqual(a.json.devices.map((row) => row.id), [teamA.deviceId]);
    assert.strictEqual(b.json.totalEvents, 1); assert.deepStrictEqual(b.json.devices.map((row) => row.id), [teamB.deviceId]);
    const ownerView = await accountRequest(port, ownerA, 'GET',
      '/api/v1/account/fleet?companyId=' + companyA.company.id);
    const administratorView = await accountRequest(port, administratorSession, 'GET',
      '/api/v1/account/fleet?companyId=' + companyA.company.id);
    assert.strictEqual(ownerView.json.totalEvents, 1); assert.strictEqual(administratorView.json.totalEvents, 1);
    assert.ok(ownerView.json.devices.some((row) => row.id === teamA.deviceId));
    assert.ok(administratorView.json.devices.some((row) => row.id === teamA.deviceId));
    const foreign = await accountRequest(port, outsiderSession, 'GET',
      '/api/v1/account/fleet?companyId=' + companyA.company.id + '&userId=' + member.id);
    assert.strictEqual(foreign.status, 404);
    assert.strictEqual(await repository.userFleet(pool, outsider, { companyId: companyB.company.id }), null);
    assert.strictEqual((await accountRequest(port, memberSession, 'GET',
      '/api/v1/account/fleet?companyId=not-a-uuid')).status, 404);
    assert.strictEqual((await accountRequest(port, ownerA, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members', {
        userId: 'not-a-uuid', role: 'member'
      })).status, 404);
    await assert.rejects(
      pool.query(
        `INSERT INTO usage_events(company_id,owner_user_id,event_id,device_id,harness,provider,model,
                                  occurred_at,tokens,source,pricing_status,pricing_amount,pricing_flat_amount,
                                  pricing_catalogue_version)
         VALUES ($1,$2,'direct-scope-forgery',$3,'codex','test','openai/gpt-5.2',now(),$4::jsonb,
                 'local-log','priced',0,0,'test')`,
        [companyA.company.id, member.id, personalOne.deviceId, JSON.stringify({ in: 1 })]
      ), /usage device scope mismatch/
    );
  });

  await test('company managers see active team devices only and never personal or foreign devices', async () => {
    managerA = await managerLogin(port, 'owner-a@example.test', 'owner a account password');
    managerB = await managerLogin(port, 'owner-b@example.test', 'owner b account password');
    assert.strictEqual(managerA.response.status, 200); assert.strictEqual(managerB.response.status, 200);
    const a = await managerRequest(port, managerA, 'GET', '/api/v1/fleet?days=30');
    const b = await managerRequest(port, managerB, 'GET', '/api/v1/fleet?days=30');
    assert.ok(a.json.devices.some((row) => row.id === teamA.deviceId));
    assert.ok(!a.json.devices.some((row) => [teamB.deviceId, personalOne.deviceId].includes(row.id)));
    assert.ok(b.json.devices.some((row) => row.id === teamB.deviceId));
    const cross = await managerRequest(port, managerA, 'POST',
      '/api/v1/manager/devices/' + teamB.deviceId + '/revoke', { companyId: companyB.company.id, userId: member.id });
    assert.strictEqual(cross.status, 404);
  });

  await test('account fleet, enrollment and membership limits are shared through PostgreSQL', async () => {
    const secondCollector = createCollector({
      pool, keepPoolOpen: true, rateLimitSecret: RATE_LIMIT_SECRET
    });
    await new Promise((resolve) => secondCollector.server.listen(0, '127.0.0.1', resolve));
    const secondPort = secondCollector.server.address().port;
    try {
      const fleetStatuses = {};
      for (let index = 0; index < 125; index++) {
        const response = await accountRequest(port, administratorSession, 'GET',
          '/api/v1/account/fleet?companyId=' + companyA.company.id);
        fleetStatuses[response.status] = (fleetStatuses[response.status] || 0) + 1;
        if (response.status === 429) assert.deepStrictEqual(response.json, { error: 'too many requests' });
      }
      for (let index = 0; index < 125; index++) {
        const response = await accountRequest(secondPort, administratorSession, 'GET',
          '/api/v1/account/fleet?companyId=' + companyA.company.id);
        fleetStatuses[response.status] = (fleetStatuses[response.status] || 0) + 1;
        if (response.status === 429) assert.deepStrictEqual(response.json, { error: 'too many requests' });
      }
      assert.ok(fleetStatuses[200] > 0); assert.ok(fleetStatuses[429] > 0);

      const enrollmentStatuses = {};
      for (let index = 0; index < 61; index++) {
        const response = await accountRequest(port, outsiderSession, 'POST',
          '/api/v1/account/enrollment-codes', { companyId: null, ttlMinutes: 15 });
        enrollmentStatuses[response.status] = (enrollmentStatuses[response.status] || 0) + 1;
        if (response.status === 429) assert.deepStrictEqual(response.json, { error: 'too many requests' });
      }
      assert.ok(enrollmentStatuses[201] > 0); assert.ok(enrollmentStatuses[429] > 0);

      const membershipStatuses = {};
      for (let index = 0; index < 61; index++) {
        const response = await accountRequest(port, ownerB, 'POST',
          '/api/v1/account/workspaces/' + companyB.company.id + '/members', {
            email: 'missing-' + index + '@example.test', role: 'member'
          });
        membershipStatuses[response.status] = (membershipStatuses[response.status] || 0) + 1;
        if (response.status === 429) assert.deepStrictEqual(response.json, { error: 'too many requests' });
      }
      assert.ok(membershipStatuses[404] > 0); assert.ok(membershipStatuses[429] > 0);

      const removalStatuses = {};
      for (let index = 0; index < 61; index++) {
        const response = await accountRequest(port, outsiderSession, 'POST',
          '/api/v1/account/workspaces/' + companyA.company.id + '/members/' + companyA.user.id + '/remove', {});
        removalStatuses[response.status] = (removalStatuses[response.status] || 0) + 1;
        if (response.status === 429) assert.deepStrictEqual(response.json, { error: 'too many requests' });
      }
      assert.ok(removalStatuses[404] > 0); assert.ok(removalStatuses[429] > 0);

      for (const [route, userId, exactCount] of [
        ['account-fleet', administrator.id, 251],
        ['account-enrollment-code', outsider.id, 61],
        ['account-membership', companyB.user.id, 62],
        ['account-membership', outsider.id, 61]
      ]) {
        const key = security.keyedHash(RATE_LIMIT_SECRET, route + '\0' + userId);
        const stored = await pool.query(
          'SELECT sum(request_count)::int AS request_count FROM api_rate_limits WHERE key_hash=$1', [key]
        );
        assert.strictEqual(stored.rowCount, 1);
        assert.strictEqual(stored.rows[0].request_count, exactCount);
      }
      console.log('       fleet=' + JSON.stringify(fleetStatuses)
        + ' enrollment=' + JSON.stringify(enrollmentStatuses)
        + ' membership_add=' + JSON.stringify(membershipStatuses)
        + ' membership_remove=' + JSON.stringify(removalStatuses));
    } finally {
      await new Promise((resolve) => secondCollector.server.close(resolve));
    }
  });

  await test('membership removal revokes team credentials and removes both user and manager visibility', async () => {
    const denied = await accountRequest(port, administratorSession, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members/' + companyA.user.id + '/remove', {});
    assert.strictEqual(denied.status, 404);
    const removed = await accountRequest(port, ownerA, 'POST',
      '/api/v1/account/workspaces/' + companyA.company.id + '/members/' + member.id + '/remove', {});
    assert.strictEqual(removed.status, 200); assert.strictEqual(removed.json.revokedDevices, 1);
    const formerMember = await accountRequest(port, memberSession, 'GET',
      '/api/v1/account/fleet?companyId=' + companyA.company.id);
    assert.strictEqual(formerMember.status, 404);
    const managerView = await managerRequest(port, managerA, 'GET', '/api/v1/fleet?days=30');
    assert.ok(!managerView.json.devices.some((row) => row.id === teamA.deviceId));
    assert.strictEqual(managerView.json.totalEvents, 0);
    const upload = await request(port, 'POST', '/api/v1/events', { events: [usage('after-removal-event', { in: 1 })] }, {
      authorization: 'Bearer ' + teamA.deviceCredential
    });
    assert.strictEqual(upload.status, 401);
    assert.strictEqual((await accountRequest(port, memberSession, 'GET', '/api/v1/account/fleet')).json.totalEvents, 2);
    assert.strictEqual((await accountRequest(port, memberSession, 'GET',
      '/api/v1/account/fleet?companyId=' + companyB.company.id)).json.totalEvents, 1);
  });

  await test('unauthenticated, manager and device credentials cannot use account reads or writes', async () => {
    assert.strictEqual((await request(port, 'GET', '/api/v1/account/fleet')).status, 401);
    assert.strictEqual((await request(port, 'GET', '/api/v1/account/fleet', null, {
      authorization: 'Bearer ' + teamB.deviceCredential
    })).status, 403);
    const rawManager = decodeURIComponent(managerA.cookie.slice('up_manager='.length));
    assert.strictEqual((await request(port, 'GET', '/api/v1/account/fleet', null, {
      authorization: 'Bearer ' + rawManager
    })).status, 403);
    const missingCsrf = await request(port, 'POST', '/api/v1/account/enrollment-codes', {}, { cookie: memberSession.cookie });
    assert.strictEqual(missingCsrf.status, 403);
    const loggedOut = await accountRequest(port, outsiderSession, 'POST', '/api/v1/account/logout', {});
    assert.strictEqual(loggedOut.status, 200); assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0/);
    assert.strictEqual((await accountRequest(port, outsiderSession, 'GET', '/api/v1/account/fleet')).status, 401);
  });

  await test('deleting a company removes only its workspace data and preserves users and personal data', async () => {
    const beforePersonal = await accountRequest(port, memberSession, 'GET', '/api/v1/account/fleet');
    assert.strictEqual(beforePersonal.json.totalEvents, 2);
    await pool.query('DELETE FROM companies WHERE id=$1', [companyB.company.id]);
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM users WHERE id=$1', [member.id])).rows[0].count), 1);
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM devices WHERE id=$1', [teamB.deviceId])).rows[0].count), 0);
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM usage_events WHERE company_id=$1', [companyB.company.id])).rows[0].count), 0);
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM devices WHERE owner_user_id=$1 AND company_id IS NULL', [member.id])).rows[0].count), 2);
    assert.strictEqual((await accountRequest(port, memberSession, 'GET', '/api/v1/account/fleet')).json.totalEvents, 2);
    const workspaces = await accountRequest(port, memberSession, 'GET', '/api/v1/account/workspaces');
    assert.ok(!workspaces.json.workspaces.some((row) => row.companyId === companyB.company.id));
  });

  await new Promise((resolve) => collector.server.close(resolve));
  await pool.end();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const failure of failures) console.log('\n' + failure.name + '\n' + failure.err.stack);
    process.exit(1);
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
