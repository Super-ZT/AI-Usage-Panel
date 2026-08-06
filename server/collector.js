'use strict';

/**
 * PostgreSQL-backed company collector. It intentionally has no flat-file
 * fallback: starting without DATABASE_URL fails closed instead of creating a
 * second, unscoped source of truth.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const repository = require('./repository');
const security = require('./security');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_BATCH = 2000;
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'"
});

function bearer(req) {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

function send(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  }, SECURITY_HEADERS, extraHeaders || {}));
  res.end(payload);
}

function sendAsset(res, file, contentType) {
  const payload = fs.readFileSync(path.join(DASHBOARD_DIR, file));
  res.writeHead(200, Object.assign({
    'content-type': contentType,
    'cache-control': file === 'manager.html' ? 'no-store' : 'public, max-age=300',
    'content-length': payload.length
  }, SECURITY_HEADERS));
  res.end(payload);
}

function cookie(req, expected) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === expected) {
      try { return decodeURIComponent(value.join('=')); } catch (_) { return null; }
    }
  }
  return null;
}

function managerToken(req) {
  const auth = bearer(req);
  if (auth && auth.startsWith('upm_')) return auth;
  return cookie(req, 'up_manager') || auth;
}

function userToken(req) {
  const auth = bearer(req);
  if (auth && auth.startsWith('upu_')) return auth;
  return cookie(req, 'up_user') || auth;
}

function sameToken(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && security.tokenMatches(left, security.tokenHash(right));
}

function sessionCookie(token, maxAge) {
  return `up_manager=${token ? encodeURIComponent(token) : ''}; Path=/api/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function preloginCookie(token, maxAge) {
  return `up_prelogin_csrf=${token ? encodeURIComponent(token) : ''}; Path=/api/v1/manager/login; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function userSessionCookie(token, maxAge) {
  return `up_user=${token ? encodeURIComponent(token) : ''}; Path=/api/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function accountPreloginCookie(token, maxAge) {
  return `up_account_prelogin_csrf=${token ? encodeURIComponent(token) : ''}; Path=/api/v1/account/login; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readJSON(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > (limit || MAX_BODY_BYTES)) {
        failed = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.resume();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function requestSource(req, trustedProxyHops) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!trustedProxyHops) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!forwarded.length) return remote;
  return forwarded[Math.max(0, forwarded.length - trustedProxyHops)] || remote;
}

function rateLimiter(pool, options) {
  const secret = options && options.secret ? options.secret : security.randomToken('upr_');
  const trustedProxyHops = boundedInteger(options && options.trustedProxyHops, 0, 0, 8);
  return async function allowed(req, route, cap, globalCap, identity) {
    const subject = identity || requestSource(req, trustedProxyHops);
    return repository.consumeRateLimit(
      pool,
      security.keyedHash(secret, route + '\u0000' + subject),
      security.keyedHash(secret, 'global\u0000' + route),
      cap,
      globalCap
    );
  };
}

function createCollector(options) {
  const pool = options && options.pool ? options.pool : repository.createPool();
  const allowed = rateLimiter(pool, {
    secret: (options && options.rateLimitSecret) || process.env.RATE_LIMIT_SECRET,
    trustedProxyHops: (options && options.trustedProxyHops) == null
      ? process.env.TRUSTED_PROXY_HOPS : options.trustedProxyHops
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Public portal path is implemented but not published externally yet.
      // Keep /manager for local/ops access; both share the same authenticated fleet API.
      if (req.method === 'GET' && (
        url.pathname === '/manager' || url.pathname === '/manager/'
        || url.pathname === '/portal/usage-panel' || url.pathname === '/portal/usage-panel/'
      )) {
        return sendAsset(res, 'manager.html', 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && (
        url.pathname === '/manager/manager.css'
        || url.pathname === '/portal/usage-panel/manager.css'
      )) {
        return sendAsset(res, 'manager.css', 'text/css; charset=utf-8');
      }
      if (req.method === 'GET' && (
        url.pathname === '/manager/manager.js'
        || url.pathname === '/portal/usage-panel/manager.js'
      )) {
        return sendAsset(res, 'manager.js', 'text/javascript; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname === '/live') {
        return send(res, 200, { ok: true, service: 'usage-panel-collector' });
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
        const ready = await repository.readiness(pool);
        return send(res, 200, { ok: true, service: 'usage-panel-collector', storage: 'postgresql', ready });
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/manager/csrf') {
        if (!(await allowed(req, 'manager-csrf', 120, 3000))) return send(res, 429, { error: 'too many requests' });
        const csrfToken = security.randomToken('upc_');
        return send(res, 200, { csrfToken }, { 'set-cookie': preloginCookie(csrfToken, 600) });
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/account/csrf') {
        if (!(await allowed(req, 'account-csrf', 120, 3000))) return send(res, 429, { error: 'too many requests' });
        const csrfToken = security.randomToken('upc_');
        return send(res, 200, { csrfToken }, { 'set-cookie': accountPreloginCookie(csrfToken, 600) });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/account/login') {
        if (!(await allowed(req, 'account-login', 10, 1000))) return send(res, 429, { error: 'too many requests' });
        const csrf = req.headers['x-csrf-token'];
        if (!sameToken(csrf, cookie(req, 'up_account_prelogin_csrf'))) {
          return send(res, 403, { error: 'request rejected' });
        }
        const body = await readJSON(req, 16 * 1024);
        const login = await repository.loginUser(pool, body || {});
        if (!login) return send(res, 401, { error: 'invalid credentials' });
        const maxAge = Math.max(1, Math.floor((new Date(login.expiresAt).getTime() - Date.now()) / 1000));
        return send(res, 200, {
          expiresAt: login.expiresAt, user: login.user, csrfToken: login.csrfToken
        }, { 'set-cookie': [userSessionCookie(login.token, maxAge), accountPreloginCookie('', 0)] });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/manager/login') {
        if (!(await allowed(req, 'manager-login', 10, 1000))) return send(res, 429, { error: 'too many requests' });
        const csrf = req.headers['x-csrf-token'];
        if (!sameToken(csrf, cookie(req, 'up_prelogin_csrf'))) {
          return send(res, 403, { error: 'request rejected' });
        }
        const body = await readJSON(req, 16 * 1024);
        const login = await repository.loginManager(pool, body || {});
        if (!login) return send(res, 401, { error: 'invalid credentials' });
        const maxAge = Math.max(1, Math.floor((new Date(login.expiresAt).getTime() - Date.now()) / 1000));
        return send(res, 200, {
          expiresAt: login.expiresAt,
          manager: login.manager,
          csrfToken: login.csrfToken
        }, { 'set-cookie': [sessionCookie(login.token, maxAge), preloginCookie('', 0)] });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/enroll') {
        if (!(await allowed(req, 'device-enroll', 20, 2000))) return send(res, 429, { error: 'too many requests' });
        const body = await readJSON(req, 32 * 1024);
        const enrolled = await repository.enrollDevice(pool, body || {});
        if (!enrolled) return send(res, 401, { error: 'invalid or expired enrollment code' });
        return send(res, 201, {
          deviceId: enrolled.device.id,
          deviceCredential: enrolled.credential,
          label: enrolled.device.label,
          platform: enrolled.device.platform
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/events') {
        const token = bearer(req);
        if (token && token.startsWith('upm_')) return send(res, 403, { error: 'device credential required' });
        const device = await repository.deviceByToken(pool, token);
        if (!device) return send(res, 401, { error: 'unauthorized' });
        if (!(await allowed(req, 'device-events', 120, 12000, device.id))) return send(res, 429, { error: 'too many requests' });
        const body = await readJSON(req);
        if (!body || !Array.isArray(body.events)) return send(res, 400, { error: 'events must be an array' });
        if (body.events.length > MAX_EVENTS_PER_BATCH) return send(res, 413, { error: 'too many events' });
        const stored = await repository.storeEvents(pool, device, body.events);
        return send(res, 200, {
          accepted: stored.accepted,
          duplicates: stored.duplicates,
          rejected: stored.rejected.length,
          permanentlyRejected: stored.rejected
        });
      }

      if (url.pathname.startsWith('/api/v1/account/')) {
        const token = userToken(req);
        if (token && (token.startsWith('upd_') || token.startsWith('upm_'))) {
          return send(res, 403, { error: 'user session required' });
        }
        const user = await repository.userByToken(pool, token);
        if (!user) return send(res, 401, { error: 'unauthorized' });

        if (req.method === 'GET' && url.pathname === '/api/v1/account/session') {
          const csrfToken = await repository.rotateUserCsrf(pool, token, user);
          if (!csrfToken) return send(res, 401, { error: 'unauthorized' });
          return send(res, 200, {
            user: { id: user.id, email: user.email },
            memberships: await repository.listMemberships(pool, user),
            expiresAt: user.expiresAt.toISOString(), csrfToken
          });
        }

        const stateChanging = req.method === 'POST';
        if (stateChanging && !repository.userCsrfMatches(user, req.headers['x-csrf-token'])) {
          return send(res, 403, { error: 'request rejected' });
        }
        if (req.method === 'POST' && url.pathname === '/api/v1/account/logout') {
          await repository.logoutUser(pool, token, user);
          return send(res, 200, { loggedOut: true }, { 'set-cookie': userSessionCookie('', 0) });
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/account/workspaces') {
          return send(res, 200, { workspaces: await repository.listMemberships(pool, user) });
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/account/fleet') {
          if (!(await allowed(req, 'account-fleet', 120, 6000, user.id))) {
            return send(res, 429, { error: 'too many requests' });
          }
          const fleet = await repository.userFleet(pool, user, {
            companyId: url.searchParams.get('companyId'),
            days: url.searchParams.get('days'), deviceId: url.searchParams.get('device'),
            harness: url.searchParams.get('tool')
          });
          if (!fleet) return send(res, 404, { error: 'workspace not found' });
          return send(res, 200, fleet);
        }
        if (req.method === 'POST' && url.pathname === '/api/v1/account/enrollment-codes') {
          if (!(await allowed(req, 'account-enrollment-code', 30, 1000, user.id))) {
            return send(res, 429, { error: 'too many requests' });
          }
          const body = await readJSON(req, 8 * 1024);
          const created = await repository.createUserEnrollment(
            pool, user, body && body.companyId, body && body.ttlMinutes
          );
          if (!created) return send(res, 404, { error: 'workspace not found' });
          return send(res, 201, { enrollmentCode: created.code, expiresAt: created.expiresAt });
        }
        const addMember = /^\/api\/v1\/account\/workspaces\/([0-9a-f-]{36})\/members$/i.exec(url.pathname);
        if (req.method === 'POST' && addMember) {
          if (!(await allowed(req, 'account-membership', 30, 1000, user.id))) {
            return send(res, 429, { error: 'too many requests' });
          }
          const body = await readJSON(req, 8 * 1024);
          const added = await repository.addMembership(pool, user, Object.assign({}, body, { companyId: addMember[1] }));
          if (!added) return send(res, 404, { error: 'workspace or user not found' });
          return send(res, 201, added);
        }
        const removeMember = /^\/api\/v1\/account\/workspaces\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})\/remove$/i.exec(url.pathname);
        if (req.method === 'POST' && removeMember) {
          if (!(await allowed(req, 'account-membership', 30, 1000, user.id))) {
            return send(res, 429, { error: 'too many requests' });
          }
          const removed = await repository.removeMembership(pool, user, removeMember[1], removeMember[2]);
          if (!removed) return send(res, 404, { error: 'membership not found' });
          return send(res, 200, removed);
        }
        return send(res, 404, { error: 'not found' });
      }

      const token = managerToken(req);
      if (token && token.startsWith('upd_')) return send(res, 403, { error: 'manager session required' });
      const manager = await repository.managerByToken(pool, token);
      if (!manager) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/api/v1/manager/session') {
        const csrfToken = await repository.rotateManagerCsrf(pool, token, manager);
        if (!csrfToken) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, {
          manager: {
            id: manager.id, email: manager.email,
            companyId: manager.companyId, companyName: manager.companyName
          },
          expiresAt: manager.expiresAt.toISOString(), csrfToken
        });
      }

      const stateChangingManagerRequest = req.method === 'POST' && (
        url.pathname === '/api/v1/manager/logout'
        || url.pathname === '/api/v1/manager/enrollment-codes'
        || /^\/api\/v1\/manager\/devices\/.+\/revoke$/.test(url.pathname)
      );
      if (stateChangingManagerRequest && !repository.managerCsrfMatches(manager, req.headers['x-csrf-token'])) {
        return send(res, 403, { error: 'request rejected' });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/manager/logout') {
        await repository.logoutManager(pool, token, manager);
        return send(res, 200, { loggedOut: true }, { 'set-cookie': sessionCookie('', 0) });
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/fleet') {
        if (!(await allowed(req, 'manager-fleet', 120, 6000, manager.id))) return send(res, 429, { error: 'too many requests' });
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
        return send(res, 200, await repository.fleet(pool, manager, {
          days, deviceId: url.searchParams.get('device'), harness: url.searchParams.get('tool')
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/manager/enrollment-codes') {
        if (!(await allowed(req, 'manager-enrollment-code', 30, 1000, manager.id))) return send(res, 429, { error: 'too many requests' });
        const body = await readJSON(req, 8 * 1024);
        const created = await repository.createEnrollment(pool, manager, body && body.ttlMinutes);
        return send(res, 201, { enrollmentCode: created.code, expiresAt: created.expiresAt });
      }

      const revoke = /^\/api\/v1\/manager\/devices\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/revoke$/i.exec(url.pathname);
      if (req.method === 'POST' && revoke) {
        if (!(await allowed(req, 'manager-revoke', 60, 1000, manager.id))) return send(res, 429, { error: 'too many requests' });
        const changed = await repository.revokeDevice(pool, manager, revoke[1]);
        if (!changed) return send(res, 404, { error: 'device not found' });
        return send(res, 200, changed);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 500;
      return send(res, status, { error: status < 500 ? err.message : 'internal server error' });
    }
  });

  server.requestTimeout = boundedInteger(process.env.HTTP_REQUEST_TIMEOUT_MS, 30000, 1000, 120000);
  server.headersTimeout = boundedInteger(process.env.HTTP_HEADERS_TIMEOUT_MS, 10000, 1000, 60000);
  server.keepAliveTimeout = boundedInteger(process.env.HTTP_KEEPALIVE_TIMEOUT_MS, 5000, 1000, 30000);
  server.maxRequestsPerSocket = boundedInteger(process.env.HTTP_MAX_REQUESTS_PER_SOCKET, 1000, 1, 10000);

  server.on('close', () => {
    if (!(options && options.keepPoolOpen)) pool.end().catch(() => {});
  });
  return { server, pool };
}

async function start() {
  const port = Number(process.env.PORT) || 8900;
  const host = process.env.HOST || '0.0.0.0';
  const collector = createCollector();
  if (process.env.AUTO_MIGRATE === '0') await repository.readiness(collector.pool);
  else await repository.migrate(collector.pool);
  if (process.env.RETENTION_ENABLED !== '0') {
    await repository.purgeOperationalFacts(collector.pool, retentionOptions());
    const interval = boundedInteger(process.env.RETENTION_INTERVAL_MS, 6 * 60 * 60 * 1000, 60000, 7 * 86400000);
    collector.retentionTimer = setInterval(() => {
      repository.purgeOperationalFacts(collector.pool, retentionOptions())
        .catch(() => console.error('Operational retention failed'));
    }, interval);
    collector.retentionTimer.unref();
  }
  await new Promise((resolve, reject) => {
    collector.server.once('error', reject);
    collector.server.listen(port, host, resolve);
  });
  console.log('Usage Panel collector listening on http://' + host + ':' + port);
  console.log('  storage: PostgreSQL');
  return collector;
}

function retentionOptions() {
  return {
    rejectionDays: Number(process.env.REJECTION_RETENTION_DAYS),
    auditDays: Number(process.env.AUDIT_RETENTION_DAYS),
    sessionDays: Number(process.env.SESSION_RETENTION_DAYS),
    enrollmentDays: Number(process.env.ENROLLMENT_RETENTION_DAYS),
    rejectionCap: Number(process.env.REJECTION_RETENTION_CAP),
    auditCap: Number(process.env.AUDIT_RETENTION_CAP)
  };
}

async function shutdown(collector) {
  if (!collector || collector.closing) return;
  collector.closing = true;
  if (collector.retentionTimer) clearInterval(collector.retentionTimer);
  const deadline = setTimeout(() => {
    if (typeof collector.server.closeAllConnections === 'function') collector.server.closeAllConnections();
  }, 10000);
  deadline.unref();
  await new Promise((resolve) => collector.server.close(resolve));
  await collector.pool.end();
  clearTimeout(deadline);
}

if (require.main === module) {
  start().then((collector) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      shutdown(collector).catch(() => { process.exitCode = 1; });
    });
  }).catch(() => {
    console.error('Usage Panel collector could not start; check DATABASE_URL and migrations');
    process.exit(1);
  });
}

module.exports = { createCollector, start, shutdown, readJSON, rateLimiter, requestSource, retentionOptions };
