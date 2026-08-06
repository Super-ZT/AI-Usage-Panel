'use strict';

const assert = require('assert');
const https = require('https');

const endpoint = new URL(process.env.OPS_STACK_URL || 'https://localhost:18443');
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function request(method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const requestHeaders = { ...(headers || {}) };
    if (payload) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = payload.length;
    }
    const req = https.request({
      protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port,
      method, path: route, headers: requestHeaders, agent, timeout: 5000
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch (_) { /* handled by assertions */ }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('stack HTTP request timed out')));
    req.end(payload || undefined);
  });
}

function cookie(response, name) {
  const values = response.headers['set-cookie'] || [];
  const found = values.find((value) => value.startsWith(name + '='));
  return found && found.split(';')[0];
}

async function login(email, password) {
  const prelogin = await request('GET', '/api/v1/manager/csrf');
  assert.strictEqual(prelogin.status, 200);
  const response = await request('POST', '/api/v1/manager/login', { email, password }, {
    cookie: cookie(prelogin, 'up_prelogin_csrf'), 'x-csrf-token': prelogin.json.csrfToken
  });
  assert.strictEqual(response.status, 200);
  return { cookie: cookie(response, 'up_manager'), csrf: response.json.csrfToken };
}

async function managerPost(session, route, body) {
  return request('POST', route, body || {}, { cookie: session.cookie, 'x-csrf-token': session.csrf });
}

(async () => {
  const managerA = await login('offline@example.test', 'offline validation password');
  const managerB = await login('isolation@example.test', 'offline isolation password');
  const companyA = await request('GET', '/api/v1/fleet?days=30', null, { cookie: managerA.cookie });
  const companyB = await request('GET', '/api/v1/fleet?days=30', null, { cookie: managerB.cookie });
  assert.strictEqual(companyA.status, 200); assert.strictEqual(companyA.json.totalEvents, 3);
  assert.strictEqual(companyB.status, 200); assert.strictEqual(companyB.json.totalEvents, 1);
  const foreignDeviceId = companyB.json.devices[0].id;
  const tampered = await request(
    'GET', '/api/v1/fleet?days=30&company_id=' + encodeURIComponent(companyB.json.companyId || 'foreign')
      + '&device=' + encodeURIComponent(foreignDeviceId), null, { cookie: managerA.cookie }
  );
  assert.strictEqual(tampered.status, 200); assert.strictEqual(tampered.json.totalEvents, 0);
  assert.ok(!tampered.json.devices.some((device) => device.id === foreignDeviceId));
  assert.strictEqual((await managerPost(managerA,
    '/api/v1/manager/devices/' + foreignDeviceId + '/revoke')).status, 404);

  const code = await managerPost(managerA, '/api/v1/manager/enrollment-codes', { ttlMinutes: 15 });
  assert.strictEqual(code.status, 201);
  const enrollment = await request('POST', '/api/v1/enroll', {
    code: code.json.enrollmentCode, label: 'http-validation-device', platform: 'stack'
  });
  assert.strictEqual(enrollment.status, 201);
  const upload = await request('POST', '/api/v1/events', { events: [{
    event_id: 'stack-http-event-0001', harness: 'codex', provider: 'stack',
    model: 'openai/gpt-5.2', pricing_model: 'openai/gpt-5.2', ts: new Date().toISOString(),
    tokens: { in: 21, out: 4 }, source: 'local-log'
  }] }, { authorization: 'Bearer ' + enrollment.json.deviceCredential });
  assert.strictEqual(upload.status, 200); assert.strictEqual(upload.json.accepted.length, 1);
  const revoke = await managerPost(managerA,
    '/api/v1/manager/devices/' + enrollment.json.deviceId + '/revoke');
  assert.strictEqual(revoke.status, 200);
  assert.strictEqual((await request('POST', '/api/v1/events', { events: [] }, {
    authorization: 'Bearer ' + enrollment.json.deviceCredential
  })).status, 401);

  const logout = await managerPost(managerA, '/api/v1/manager/logout');
  assert.strictEqual(logout.status, 200);
  assert.strictEqual((await request('GET', '/api/v1/fleet?days=30', null, { cookie: managerA.cookie })).status, 401);
  console.log(JSON.stringify({
    httpsLogin: 200, companyAEventsBeforeUpload: 3, companyBEvents: 1,
    foreignDeviceFilterEvents: 0, crossCompanyRevoke: 404, uploadAccepted: 1,
    revokedUpload: 401, loggedOutRead: 401
  }));
})().catch((err) => { console.error(err.message); process.exit(1); });
