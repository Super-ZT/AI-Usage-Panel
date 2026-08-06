'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pricing = require('../src/core/pricing');
const security = require('./security');

const PRICING_MIGRATION = '004_operations_readiness.sql';
const MAX_FLEET_DEVICES = 5000;
const MAX_FLEET_TOOLS = 1000;
const MAX_FLEET_MODELS = 2000;
const MAX_FLEET_SOURCES = 100;
const PRICING_REFRESH_BATCH = 500;
const OPENROUTER_EQUIVALENT_LABEL = 'OpenRouter-equivalent estimate';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createPool(connectionString) {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required; the collector will not fall back to flat files');
  return new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_SIZE) || 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: true } : undefined
  });
}

async function migrate(pool) {
  const client = await pool.connect();
  const names = fs.readdirSync(path.join(__dirname, 'migrations'))
    .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('usage-panel-schema-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = path.join(__dirname, 'migrations');
    for (const name of names) {
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (already.rowCount) continue;
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (name === PRICING_MIGRATION) await refreshEventPricing(client, { transactionManaged: true });
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    await refreshEventPricing(client);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('usage-panel-schema-migrations'))"); } catch (_) { /* connection cleanup */ }
    client.release();
  }
  return names;
}

function eventPricing(model, pricingModel, tokens) {
  const priced = pricing.priceTokens(pricingModel || model, tokens || {});
  return {
    status: priced.status,
    amount: priced.amount,
    flatAmount: priced.flatAmount,
    version: pricing.snapshot.version,
    unpricedModel: priced.status === 'unknown' ? (model || 'unknown') : null
  };
}

async function refreshEventPricing(client, options) {
  let updated = 0;
  while (true) {
    if (!(options && options.transactionManaged)) await client.query('BEGIN');
    try {
      const rows = await client.query(
        `SELECT device_id, event_id, model, pricing_model, tokens
           FROM usage_events
          WHERE pricing_catalogue_version IS DISTINCT FROM $1
          ORDER BY device_id, event_id
          LIMIT $2 FOR UPDATE`,
        [pricing.snapshot.version, PRICING_REFRESH_BATCH]
      );
      for (const row of rows.rows) {
        const cost = eventPricing(row.model, row.pricing_model, row.tokens);
        await client.query(
          `UPDATE usage_events
              SET pricing_status=$1, pricing_amount=$2, pricing_flat_amount=$3,
                  pricing_catalogue_version=$4, pricing_unpriced_model=$5
            WHERE device_id=$6 AND event_id=$7`,
          [cost.status, cost.amount, cost.flatAmount, cost.version, cost.unpricedModel,
            row.device_id, row.event_id]
        );
      }
      if (!(options && options.transactionManaged)) await client.query('COMMIT');
      updated += rows.rowCount;
      if (rows.rowCount < PRICING_REFRESH_BATCH) return updated;
    } catch (err) {
      if (!(options && options.transactionManaged)) await client.query('ROLLBACK');
      throw err;
    }
  }
}

function email(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
    throw new Error('invalid manager email');
  }
  return normalized;
}

function safeText(value, max, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : fallback;
}

const EVENT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const EVENT_TIMESTAMP_MIN = Date.parse('2000-01-01T00:00:00.000Z');
const EVENT_TIMESTAMP_MAX = Date.parse('2100-01-01T00:00:00.000Z');

function eventText(value, name, max, fallback) {
  if (value == null || value === '') return { value: fallback, reason: null };
  if (typeof value !== 'string' || EVENT_CONTROL_CHARACTERS.test(value)) {
    return { value: null, reason: 'invalid ' + name };
  }
  const text = value.trim();
  if (!text) return { value: fallback, reason: fallback == null ? 'invalid ' + name : null };
  return { value: text.slice(0, max), reason: null };
}

function safeRejectionEventId(raw) {
  const value = raw && raw.event_id;
  if (typeof value !== 'string' || value.length < 8 || value.length > 128
      || EVENT_CONTROL_CHARACTERS.test(value)) return null;
  return value;
}

async function recordUsageRejection(client, device, raw, eventIndex, reason) {
  const eventId = safeRejectionEventId(raw);
  await client.query(
    `INSERT INTO usage_rejections(company_id, owner_user_id, device_id, event_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [device.companyId || null, device.ownerUserId, device.id, eventId, reason]
  );
  const rejection = { event_index: eventIndex, reason };
  if (eventId) rejection.event_id = eventId;
  return rejection;
}

async function bootstrapCompany(pool, input) {
  const slug = String(input.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error('invalid company slug');
  const managerEmail = email(input.email);
  const password = await security.hashPassword(input.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const company = await client.query(
      'INSERT INTO companies(slug, name) VALUES ($1, $2) RETURNING id, slug, name',
      [slug, safeText(input.name, 160, slug)]
    );
    const user = await client.query(
      `INSERT INTO users(email, password_salt, password_hash, password_params)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id, email`,
      [managerEmail, password.salt, password.hash, JSON.stringify(password.params)]
    );
    await client.query(
      `INSERT INTO company_memberships(company_id, user_id, role)
       VALUES ($1, $2, 'owner')`, [company.rows[0].id, user.rows[0].id]
    );
    const manager = await client.query(
      `INSERT INTO managers(company_id, user_id, email, password_salt, password_hash, password_params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id, user_id, email`,
      [company.rows[0].id, user.rows[0].id, managerEmail, password.salt, password.hash, JSON.stringify(password.params)]
    );
    await client.query(
      `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, outcome)
       VALUES ($1, 'system', $2, 'company.bootstrap', 'allowed')`,
      [company.rows[0].id, manager.rows[0].id]
    );
    await client.query('COMMIT');
    return { company: company.rows[0], user: user.rows[0], manager: manager.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loginManager(pool, input) {
  let managerEmail;
  try { managerEmail = email(input.email); } catch (_) { managerEmail = 'invalid@example.invalid'; }
  const found = await pool.query(
    `SELECT m.id, m.user_id, m.company_id, m.email, m.password_salt, m.password_hash, m.password_params,
            c.name AS company_name
       FROM managers m
       JOIN companies c ON c.id=m.company_id
       JOIN company_memberships cm ON cm.company_id=m.company_id AND cm.user_id=m.user_id
       JOIN users u ON u.id=m.user_id
      WHERE lower(m.email) = $1 AND m.disabled_at IS NULL AND u.disabled_at IS NULL
        AND cm.revoked_at IS NULL AND cm.role IN ('owner', 'administrator')`,
    [managerEmail]
  );
  const row = found.rows[0];
  // Unknown email addresses take the same intentionally expensive password
  // path as known ones, reducing timing-based account discovery.
  const verified = await security.verifyPassword(
    String(input.password || ''),
    row ? row.password_salt : Buffer.alloc(16),
    row ? row.password_hash : Buffer.alloc(64),
    row ? row.password_params : security.PASSWORD_PARAMS
  );
  const ok = !!row && verified;
  if (!ok) {
    if (row) await pool.query(
      `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, outcome, reason)
       VALUES ($1, 'manager', $2, 'manager.login', 'denied', 'invalid credentials')`,
      [row.company_id, row.id]
    );
    return null;
  }
  const token = security.randomToken('upm_');
  const csrfToken = security.randomToken('upc_');
  const hours = Math.min(24, Math.max(1, Number(input.sessionHours) || 8));
  const session = await pool.query(
    `INSERT INTO manager_sessions(token_hash, csrf_hash, manager_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 hour')) RETURNING expires_at`,
    [security.tokenHash(token), security.tokenHash(csrfToken), row.id, hours]
  );
  await pool.query(
    `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, outcome)
     VALUES ($1, 'manager', $2, 'manager.login', 'allowed')`, [row.company_id, row.id]
  );
  return {
    token,
    csrfToken,
    expiresAt: session.rows[0].expires_at.toISOString(),
    manager: { id: row.id, userId: row.user_id, email: row.email,
      companyId: row.company_id, companyName: row.company_name }
  };
}

async function managerByToken(pool, token) {
  if (typeof token !== 'string' || !token.startsWith('upm_')) return null;
  const found = await pool.query(
    `UPDATE manager_sessions s SET last_seen_at = now()
       FROM managers m
       JOIN companies c ON c.id=m.company_id
       JOIN company_memberships cm ON cm.company_id=m.company_id AND cm.user_id=m.user_id
       JOIN users u ON u.id=m.user_id
      WHERE s.token_hash = $1 AND s.manager_id = m.id AND s.revoked_at IS NULL
        AND s.expires_at > now() AND m.disabled_at IS NULL AND u.disabled_at IS NULL
        AND cm.revoked_at IS NULL AND cm.role IN ('owner', 'administrator')
      RETURNING m.id, m.user_id, m.company_id, m.email, c.name AS company_name,
                s.expires_at, s.csrf_hash`,
    [security.tokenHash(token)]
  );
  const row = found.rows[0];
  return row ? {
    id: row.id, userId: row.user_id, companyId: row.company_id,
    companyName: row.company_name, email: row.email,
    expiresAt: row.expires_at, csrfHash: row.csrf_hash
  } : null;
}

function managerCsrfMatches(manager, token) {
  return !!manager && typeof token === 'string' && token.startsWith('upc_')
    && security.tokenMatches(token, manager.csrfHash);
}

async function rotateManagerCsrf(pool, sessionToken, manager) {
  const csrfToken = security.randomToken('upc_');
  const changed = await pool.query(
    `UPDATE manager_sessions SET csrf_hash=$1, last_seen_at=now()
      WHERE token_hash=$2 AND manager_id=$3 AND revoked_at IS NULL AND expires_at>now()`,
    [security.tokenHash(csrfToken), security.tokenHash(sessionToken), manager.id]
  );
  return changed.rowCount ? csrfToken : null;
}

async function logoutManager(pool, sessionToken, manager) {
  const changed = await pool.query(
    `UPDATE manager_sessions SET revoked_at=COALESCE(revoked_at, now())
      WHERE token_hash=$1 AND manager_id=$2 AND revoked_at IS NULL`,
    [security.tokenHash(sessionToken), manager.id]
  );
  if (changed.rowCount) await pool.query(
    `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, outcome)
     VALUES ($1, 'manager', $2, 'manager.logout', 'allowed')`,
    [manager.companyId, manager.id]
  );
  return !!changed.rowCount;
}

function publicUser(row) {
  return { id: row.id, email: row.email };
}

async function createUser(pool, input) {
  const userEmail = email(input.email);
  const password = await security.hashPassword(input.password);
  const created = await pool.query(
    `INSERT INTO users(email, password_salt, password_hash, password_params)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id, email`,
    [userEmail, password.salt, password.hash, JSON.stringify(password.params)]
  );
  return publicUser(created.rows[0]);
}

async function loginUser(pool, input) {
  let userEmail;
  try { userEmail = email(input.email); } catch (_) { userEmail = 'invalid@example.invalid'; }
  const found = await pool.query(
    `SELECT id, email, password_salt, password_hash, password_params
       FROM users WHERE lower(email)=$1 AND disabled_at IS NULL`, [userEmail]
  );
  const row = found.rows[0];
  const verified = await security.verifyPassword(
    String(input.password || ''),
    row ? row.password_salt : Buffer.alloc(16),
    row ? row.password_hash : Buffer.alloc(64),
    row ? row.password_params : security.PASSWORD_PARAMS
  );
  if (!row || !verified) return null;
  const token = security.randomToken('upu_');
  const csrfToken = security.randomToken('upc_');
  const hours = Math.min(24, Math.max(1, Number(input.sessionHours) || 8));
  const session = await pool.query(
    `INSERT INTO user_sessions(token_hash, csrf_hash, user_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 hour')) RETURNING expires_at`,
    [security.tokenHash(token), security.tokenHash(csrfToken), row.id, hours]
  );
  return {
    token, csrfToken, expiresAt: session.rows[0].expires_at.toISOString(), user: publicUser(row)
  };
}

async function userByToken(pool, token) {
  if (typeof token !== 'string' || !token.startsWith('upu_')) return null;
  const found = await pool.query(
    `UPDATE user_sessions s SET last_seen_at=now()
       FROM users u
      WHERE s.token_hash=$1 AND s.user_id=u.id AND s.revoked_at IS NULL
        AND s.expires_at>now() AND u.disabled_at IS NULL
      RETURNING u.id, u.email, s.expires_at, s.csrf_hash`, [security.tokenHash(token)]
  );
  const row = found.rows[0];
  return row ? {
    id: row.id, email: row.email, expiresAt: row.expires_at, csrfHash: row.csrf_hash
  } : null;
}

function userCsrfMatches(user, token) {
  return !!user && typeof token === 'string' && token.startsWith('upc_')
    && security.tokenMatches(token, user.csrfHash);
}

async function rotateUserCsrf(pool, sessionToken, user) {
  const csrfToken = security.randomToken('upc_');
  const changed = await pool.query(
    `UPDATE user_sessions SET csrf_hash=$1, last_seen_at=now()
      WHERE token_hash=$2 AND user_id=$3 AND revoked_at IS NULL AND expires_at>now()`,
    [security.tokenHash(csrfToken), security.tokenHash(sessionToken), user.id]
  );
  return changed.rowCount ? csrfToken : null;
}

async function logoutUser(pool, sessionToken, user) {
  const changed = await pool.query(
    `UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, now())
      WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL`,
    [security.tokenHash(sessionToken), user.id]
  );
  return !!changed.rowCount;
}

async function membership(pool, userId, companyId) {
  if (!UUID_PATTERN.test(String(userId || '')) || !UUID_PATTERN.test(String(companyId || ''))) return null;
  const found = await pool.query(
    `SELECT cm.company_id, cm.user_id, cm.role, c.name AS company_name
       FROM company_memberships cm JOIN companies c ON c.id=cm.company_id
      WHERE cm.user_id=$1 AND cm.company_id=$2 AND cm.revoked_at IS NULL`,
    [userId, companyId]
  );
  return found.rows[0] || null;
}

async function listMemberships(pool, user) {
  const found = await pool.query(
    `SELECT cm.company_id, c.name AS company_name, cm.role
       FROM company_memberships cm JOIN companies c ON c.id=cm.company_id
      WHERE cm.user_id=$1 AND cm.revoked_at IS NULL ORDER BY c.name, cm.company_id`, [user.id]
  );
  return found.rows.map((row) => ({
    companyId: row.company_id, companyName: row.company_name, role: row.role
  }));
}

function membershipRole(value) {
  const role = String(value || 'member');
  if (!['owner', 'administrator', 'member'].includes(role)) {
    throw Object.assign(new Error('invalid membership role'), { statusCode: 400 });
  }
  return role;
}

async function addMembership(pool, actor, input) {
  const companyId = String(input.companyId || '');
  if (!UUID_PATTERN.test(companyId)) return null;
  const actorMembership = await membership(pool, actor.id, companyId);
  if (!actorMembership || !['owner', 'administrator'].includes(actorMembership.role)) return null;
  const role = membershipRole(input.role);
  if (actorMembership.role !== 'owner' && role !== 'member') return null;
  let target;
  if (input.userId) {
    if (!UUID_PATTERN.test(String(input.userId))) return null;
    target = (await pool.query('SELECT id,email FROM users WHERE id=$1 AND disabled_at IS NULL', [input.userId])).rows[0];
  } else {
    let targetEmail;
    try { targetEmail = email(input.email); } catch (_) { return null; }
    target = (await pool.query('SELECT id,email FROM users WHERE lower(email)=$1 AND disabled_at IS NULL', [targetEmail])).rows[0];
  }
  if (!target) return null;
  const existing = await pool.query(
    'SELECT role FROM company_memberships WHERE company_id=$1 AND user_id=$2', [companyId, target.id]
  );
  if (existing.rows[0] && existing.rows[0].role === 'owner' && role !== 'owner') return null;
  const changed = await pool.query(
    `INSERT INTO company_memberships(company_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, user_id) DO UPDATE
       SET role=EXCLUDED.role, revoked_at=NULL
     RETURNING company_id, user_id, role`, [companyId, target.id, role]
  );
  return { companyId: changed.rows[0].company_id, userId: target.id,
    email: target.email, role: changed.rows[0].role };
}

async function removeMembership(pool, actor, companyId, targetUserId) {
  if (!UUID_PATTERN.test(String(companyId || '')) || !UUID_PATTERN.test(String(targetUserId || ''))) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actorFound = await client.query(
      `SELECT role FROM company_memberships
        WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE`,
      [companyId, actor.id]
    );
    const targetFound = await client.query(
      `SELECT role FROM company_memberships
        WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE`,
      [companyId, targetUserId]
    );
    const actorRole = actorFound.rows[0] && actorFound.rows[0].role;
    const targetRole = targetFound.rows[0] && targetFound.rows[0].role;
    const allowed = targetRole && targetRole !== 'owner'
      && (actorRole === 'owner' || (actorRole === 'administrator' && targetRole === 'member'));
    if (!allowed) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `UPDATE company_memberships SET revoked_at=now()
        WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [companyId, targetUserId]
    );
    const devices = await client.query(
      `UPDATE devices SET revoked_at=COALESCE(revoked_at, now()), credential_hash=NULL
        WHERE company_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL RETURNING id`,
      [companyId, targetUserId]
    );
    await client.query(
      `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, subject_id, outcome)
       VALUES ($1, 'user', $2, 'membership.remove', $3, 'allowed')`,
      [companyId, actor.id, targetUserId]
    );
    await client.query('COMMIT');
    return { companyId, userId: targetUserId, revokedDevices: devices.rowCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function consumeRateLimit(pool, keyHash, globalHash, cap, globalCap, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowStart = new Date(Math.floor(now / 60000) * 60000);
  const expiresAt = new Date(windowStart.getTime() + 2 * 60000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const increment = async (hash) => client.query(
      `INSERT INTO api_rate_limits(key_hash, window_start, request_count, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key_hash, window_start) DO UPDATE
         SET request_count=LEAST(api_rate_limits.request_count + 1, 2147483647),
             expires_at=EXCLUDED.expires_at
       RETURNING request_count`,
      [hash, windowStart, expiresAt]
    );
    const global = await increment(globalHash);
    let allowed = Number(global.rows[0].request_count) <= globalCap;
    if (allowed) {
      const local = await increment(keyHash);
      allowed = Number(local.rows[0].request_count) <= cap;
    }
    await client.query('COMMIT');
    return allowed;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function retentionInteger(value, fallback, minimum, maximum) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= minimum && n <= maximum ? n : fallback;
}

async function purgeOperationalFacts(pool, input) {
  const options = input || {};
  const rejectionDays = retentionInteger(options.rejectionDays, 30, 1, 3650);
  const auditDays = retentionInteger(options.auditDays, 180, 7, 3650);
  const sessionDays = retentionInteger(options.sessionDays, 7, 1, 365);
  const enrollmentDays = retentionInteger(options.enrollmentDays, 7, 1, 365);
  const rejectionCap = retentionInteger(options.rejectionCap, 100000, 1000, 1000000);
  const auditCap = retentionInteger(options.auditCap, 500000, 1000, 2000000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('usage-panel-operational-retention'))");
    const oldRejections = await client.query(
      `DELETE FROM usage_rejections WHERE created_at < now() - ($1 * interval '1 day')`, [rejectionDays]
    );
    const cappedRejections = await client.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (
           PARTITION BY company_id, CASE WHEN company_id IS NULL THEN owner_user_id END
           ORDER BY created_at DESC, id DESC
         ) AS position
           FROM usage_rejections
       )
       DELETE FROM usage_rejections r USING ranked
        WHERE r.id=ranked.id AND ranked.position>$1`, [rejectionCap]
    );
    const oldAudit = await client.query(
      `DELETE FROM audit_facts WHERE created_at < now() - ($1 * interval '1 day')`, [auditDays]
    );
    const cappedAudit = await client.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at DESC, id DESC) AS position
           FROM audit_facts
       )
       DELETE FROM audit_facts a USING ranked
        WHERE a.id=ranked.id AND ranked.position>$1`, [auditCap]
    );
    const sessions = await client.query(
      `DELETE FROM manager_sessions
        WHERE expires_at < now() - ($1 * interval '1 day')
           OR (revoked_at IS NOT NULL AND revoked_at < now() - ($1 * interval '1 day'))`, [sessionDays]
    );
    const userSessions = await client.query(
      `DELETE FROM user_sessions
        WHERE expires_at < now() - ($1 * interval '1 day')
           OR (revoked_at IS NOT NULL AND revoked_at < now() - ($1 * interval '1 day'))`, [sessionDays]
    );
    const enrollments = await client.query(
      `DELETE FROM enrollment_codes
        WHERE (used_at IS NOT NULL AND used_at < now() - ($1 * interval '1 day'))
           OR expires_at < now() - ($1 * interval '1 day')`, [enrollmentDays]
    );
    const rateLimits = await client.query('DELETE FROM api_rate_limits WHERE expires_at < now()');
    await client.query('COMMIT');
    return {
      usageRejections: oldRejections.rowCount + cappedRejections.rowCount,
      auditFacts: oldAudit.rowCount + cappedAudit.rowCount,
      managerSessions: sessions.rowCount, userSessions: userSessions.rowCount,
      enrollmentCodes: enrollments.rowCount,
      rateLimits: rateLimits.rowCount
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function readiness(pool) {
  const expected = fs.readdirSync(path.join(__dirname, 'migrations'))
    .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const applied = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  if (applied.rows.map((row) => row.name).join('\n') !== expected.join('\n')) {
    throw new Error('database migrations are incomplete');
  }
  const stale = await pool.query(
    'SELECT 1 FROM usage_events WHERE pricing_catalogue_version IS DISTINCT FROM $1 LIMIT 1',
    [pricing.snapshot.version]
  );
  if (stale.rowCount) throw new Error('usage pricing refresh is incomplete');
  return { migrations: expected.length, pricingVersion: pricing.snapshot.version };
}

async function deviceByToken(pool, token) {
  if (typeof token !== 'string' || !token.startsWith('upd_')) return null;
  const found = await pool.query(
    `SELECT d.id, d.owner_user_id, d.company_id, d.label, d.platform
       FROM devices d
      WHERE d.credential_hash=$1 AND d.revoked_at IS NULL
        AND (d.company_id IS NULL OR EXISTS (
          SELECT 1 FROM company_memberships cm
           WHERE cm.company_id=d.company_id AND cm.user_id=d.owner_user_id AND cm.revoked_at IS NULL
        ))`, [security.tokenHash(token)]
  );
  const row = found.rows[0];
  return row ? { id: row.id, ownerUserId: row.owner_user_id,
    companyId: row.company_id, label: row.label, platform: row.platform } : null;
}

async function managerIdentity(pool, manager) {
  const found = await pool.query(
    `SELECT m.user_id, cm.role
       FROM managers m
       JOIN company_memberships cm ON cm.company_id=m.company_id AND cm.user_id=m.user_id
      WHERE m.id=$1 AND m.company_id=$2 AND m.disabled_at IS NULL
        AND cm.revoked_at IS NULL AND cm.role IN ('owner', 'administrator')`,
    [manager.id, manager.companyId]
  );
  return found.rows[0] || null;
}

async function createEnrollment(pool, manager, ttlMinutes) {
  const identity = await managerIdentity(pool, manager);
  if (!identity) throw Object.assign(new Error('manager is not authorized'), { statusCode: 403 });
  const minutes = Math.min(60, Math.max(1, Number(ttlMinutes) || 15));
  const code = security.randomToken('upe_');
  const result = await pool.query(
    `INSERT INTO enrollment_codes(company_id, owner_user_id, code_hash, created_by_manager_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute')) RETURNING id, expires_at`,
    [manager.companyId, identity.user_id, security.tokenHash(code), manager.id, minutes]
  );
  return { code, expiresAt: result.rows[0].expires_at.toISOString() };
}

async function createUserEnrollment(pool, user, companyId, ttlMinutes) {
  const scopedCompany = companyId == null || companyId === '' ? null : String(companyId);
  if (scopedCompany && !(await membership(pool, user.id, scopedCompany))) return null;
  const minutes = Math.min(60, Math.max(1, Number(ttlMinutes) || 15));
  const code = security.randomToken('upe_');
  const result = await pool.query(
    `INSERT INTO enrollment_codes(company_id, owner_user_id, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 minute')) RETURNING expires_at`,
    [scopedCompany, user.id, security.tokenHash(code), minutes]
  );
  return { code, expiresAt: result.rows[0].expires_at.toISOString() };
}

async function enrollDevice(pool, input) {
  if (typeof input.code !== 'string' || !input.code.startsWith('upe_')) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, company_id, owner_user_id FROM enrollment_codes
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [security.tokenHash(input.code)]
    );
    if (!found.rowCount) { await client.query('ROLLBACK'); return null; }
    const credential = security.randomToken('upd_');
    const device = await client.query(
      `INSERT INTO devices(company_id, owner_user_id, label, platform, credential_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, company_id, owner_user_id, label, platform`,
      [found.rows[0].company_id, found.rows[0].owner_user_id, safeText(input.label, 120, 'Unnamed device'),
        safeText(input.platform, 40, 'unknown'), security.tokenHash(credential)]
    );
    await client.query(
      'UPDATE enrollment_codes SET used_at = now(), used_by_device_id = $1 WHERE id = $2',
      [device.rows[0].id, found.rows[0].id]
    );
    await client.query(
      `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, subject_id, outcome)
       VALUES ($1, 'device', $2, 'device.enroll', $2, 'allowed')`,
      [device.rows[0].company_id, device.rows[0].id]
    );
    await client.query('COMMIT');
    return {
      device: {
        id: device.rows[0].id,
        ownerUserId: device.rows[0].owner_user_id,
        companyId: device.rows[0].company_id,
        label: device.rows[0].label,
        platform: device.rows[0].platform
      },
      credential
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function sanitizeEvent(raw, device) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { event: null, reason: 'event must be an object' };
  if (typeof raw.event_id !== 'string' || raw.event_id.length < 8 || raw.event_id.length > 128
      || EVENT_CONTROL_CHARACTERS.test(raw.event_id)) {
    return { event: null, reason: 'invalid event_id' };
  }
  const harness = eventText(raw.harness, 'harness', 64, null);
  if (harness.reason || !harness.value) return { event: null, reason: 'invalid harness' };
  const provider = eventText(raw.provider, 'provider', 64, 'unknown');
  if (provider.reason) return { event: null, reason: provider.reason };
  const model = eventText(raw.model, 'model', 200, null);
  if (model.reason) return { event: null, reason: model.reason };
  const pricingModel = eventText(raw.pricing_model, 'pricing_model', 200, null);
  if (pricingModel.reason) return { event: null, reason: pricingModel.reason };
  const eventSource = eventText(raw.source, 'source', 32, 'proxy');
  if (eventSource.reason) return { event: null, reason: eventSource.reason };
  const occurredMs = new Date(raw.ts).getTime();
  if (!Number.isFinite(occurredMs) || occurredMs < EVENT_TIMESTAMP_MIN || occurredMs >= EVENT_TIMESTAMP_MAX) {
    return { event: null, reason: 'invalid timestamp' };
  }
  const number = (value, name) => {
    if (value == null) return 0;
    const n = Number(value);
    const rounded = Math.round(n);
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(rounded)) {
      throw new Error('invalid token count: ' + name);
    }
    return rounded;
  };
  const source = raw.tokens || {};
  let tokens;
  try {
    tokens = {
      in: number(source.in, 'in'), out: number(source.out, 'out'),
      cache_read: number(source.cache_read != null ? source.cache_read : source.cacheRead, 'cache_read'),
      cache_write: number(source.cache_write != null ? source.cache_write : source.cacheWrite, 'cache_write'),
      cache_write_5m: number(
        source.cache_write_5m != null ? source.cache_write_5m : source.cacheWrite5m, 'cache_write_5m'
      ),
      cache_write_1h: number(
        source.cache_write_1h != null ? source.cache_write_1h : source.cacheWrite1h, 'cache_write_1h'
      ),
      cache_write_unresolved: number(
        source.cache_write_unresolved != null ? source.cache_write_unresolved : source.cacheWriteUnresolved,
        'cache_write_unresolved'
      ),
      reasoning: number(source.reasoning, 'reasoning'), unattributed: number(source.unattributed, 'unattributed')
    };
  } catch (err) { return { event: null, reason: err.message }; }
  if (source.missing != null) {
    if (!Array.isArray(source.missing)) return { event: null, reason: 'invalid missing token categories' };
    const allowed = new Set(['in', 'out', 'cache_read', 'cache_write']);
    if (source.missing.some((name) => typeof name !== 'string' || !allowed.has(name))) {
      return { event: null, reason: 'invalid missing token categories' };
    }
    const missing = [...new Set(source.missing)];
    if (missing.length) tokens.missing = missing;
  }
  if (!tokens.in && !tokens.out && !tokens.cache_read && !tokens.cache_write && !tokens.unattributed) {
    return { event: null, reason: 'no token usage reported' };
  }
  return { event: {
    eventId: raw.event_id,
    companyId: device.companyId || null,
    ownerUserId: device.ownerUserId,
    deviceId: device.id,
    harness: harness.value,
    provider: provider.value,
    model: model.value,
    pricingModel: pricingModel.value,
    occurredAt: new Date(occurredMs).toISOString(), tokens,
    source: eventSource.value
  }, reason: null };
}

async function storeEvents(pool, device, batch) {
  const client = await pool.connect();
  const result = { accepted: [], duplicates: 0, rejected: [] };
  try {
    await client.query('BEGIN');
    const authorized = await client.query(
      `SELECT 1 FROM devices d
        WHERE d.id=$1 AND d.owner_user_id=$2
          AND d.company_id IS NOT DISTINCT FROM $3
          AND d.revoked_at IS NULL AND d.credential_hash IS NOT NULL
          AND (d.company_id IS NULL OR EXISTS (
            SELECT 1 FROM company_memberships active_membership
             WHERE active_membership.company_id=d.company_id
               AND active_membership.user_id=d.owner_user_id
               AND active_membership.revoked_at IS NULL
          ))
        FOR SHARE OF d`, [device.id, device.ownerUserId, device.companyId || null]
    );
    if (!authorized.rowCount) {
      throw Object.assign(new Error('device is not authorized'), { statusCode: 401 });
    }
    for (let eventIndex = 0; eventIndex < batch.length; eventIndex++) {
      const raw = batch[eventIndex];
      const savepoint = 'usage_event_' + eventIndex;
      await client.query('SAVEPOINT ' + savepoint);
      try {
        const checked = sanitizeEvent(raw, device);
        if (!checked.event) {
          const rejection = await recordUsageRejection(
            client, device, raw, eventIndex, checked.reason
          );
          await client.query('RELEASE SAVEPOINT ' + savepoint);
          result.rejected.push(rejection);
          continue;
        }
        const e = checked.event;
        const cost = eventPricing(e.model, e.pricingModel, e.tokens);
        const inserted = await client.query(
          `INSERT INTO usage_events(company_id, owner_user_id, event_id, device_id, harness, provider, model, pricing_model,
                                    occurred_at, tokens, source, pricing_status, pricing_amount,
                                    pricing_flat_amount, pricing_catalogue_version, pricing_unpriced_model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (device_id, event_id) DO NOTHING RETURNING event_id`,
          [e.companyId, e.ownerUserId, e.eventId, e.deviceId, e.harness, e.provider, e.model, e.pricingModel,
            e.occurredAt, JSON.stringify(e.tokens), e.source, cost.status, cost.amount,
            cost.flatAmount, cost.version, cost.unpricedModel]
        );
        await client.query('RELEASE SAVEPOINT ' + savepoint);
        if (!inserted.rowCount) result.duplicates++;
        result.accepted.push(e.eventId);
      } catch (_) {
        await client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
        const rejection = await recordUsageRejection(
          client, device, raw, eventIndex, 'event rejected by storage'
        );
        await client.query('RELEASE SAVEPOINT ' + savepoint);
        result.rejected.push(rejection);
      }
    }
    await client.query('UPDATE devices SET last_seen_at=now() WHERE owner_user_id=$1 AND id=$2',
      [device.ownerUserId, device.id]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function safeAggregateNumber(value, name) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || !Number.isSafeInteger(number)) {
    throw Object.assign(new Error(name + ' exceeds the dashboard display range'), { statusCode: 503 });
  }
  return number;
}

/**
 * Reporting labels for manager-visible buckets.
 *
 * Device uploads choose `harness` and `source` as free text. Those fields must
 * never produce a verified/provider-matched claim (e.g. "provider-accounted
 * usage"): that would let a measured device invent independent provider
 * reconciliation this service does not perform.
 *
 * Until a separate server-side provider reconciliation path exists and sets a
 * server-only verified flag, every uploaded row is either "task counters" or
 * "local". Presentation notes for Claude/Codex/Gemini account windows remain
 * descriptive policy text only — not proof that an account window was matched.
 */
function reportingLabelFor(harness, source, options) {
  const verified = options && options.providerVerified === true;
  // Server-set only. sanitizeEvent / storeEvents never copy client fields into this.
  if (verified) {
    return {
      kind: 'provider-accounted',
      label: 'provider-accounted usage',
      note: 'Server-matched provider event only; private conversation identifiers are never displayed.'
    };
  }
  const tool = String(harness || '').toLowerCase();
  const origin = String(source || '').toLowerCase().replace(/_/g, '-');
  // Named harness classes first so a local_log source cannot rebrand Claude/Codex/Gemini.
  if (tool.includes('claude') || tool.includes('codex') || tool.includes('gemini')) {
    return {
      kind: 'task-row',
      label: 'task counters',
      note: 'Device-uploaded task counters. Account-window figures for this harness are separate from task rows and are not mixed into these totals.'
    };
  }
  if (tool.includes('grok') || origin === 'local-log' || origin === 'local') {
    return {
      kind: 'local',
      label: 'local',
      note: 'Device-uploaded local counters only. Not provider-verified and not an independent account export.'
    };
  }
  return {
    kind: 'task-row',
    label: 'task counters',
    note: 'Device-uploaded token facts only. Not provider-accounted or provider-verified; money is an OpenRouter-equivalent estimate only.'
  };
}

function bucketFromAggregate(row) {
  const nullableAmount = row.pricing_amount == null ? null : Number(row.pricing_amount);
  const nullableFlatAmount = row.pricing_flat_amount == null ? null : Number(row.pricing_flat_amount);
  if ((nullableAmount != null && !Number.isFinite(nullableAmount))
      || (nullableFlatAmount != null && !Number.isFinite(nullableFlatAmount))) {
    throw Object.assign(new Error('pricing total exceeds the dashboard display range'), { statusCode: 503 });
  }
  const status = row.pricing_status;
  // Unknown must never surface as a guessed $0 exact amount.
  const amount = status === 'unknown' ? null : nullableAmount;
  const flatAmount = status === 'unknown' ? null : nullableFlatAmount;
  const unknownTokenCategories = [];
  for (const [name, field] of [
    ['in', 'missing_in'], ['out', 'missing_out'],
    ['cache_read', 'missing_cache_read'], ['cache_write', 'missing_cache_write']
  ]) {
    if (row[field]) unknownTokenCategories.push(name);
  }
  if (Number(row.tokens_unattributed || 0) > 0) {
    for (const name of ['in', 'out']) {
      if (!unknownTokenCategories.includes(name)) unknownTokenCategories.push(name);
    }
  }
  const knownModels = Number(row.known_models || 0);
  const unknownModels = Number(row.unknown_models || 0);
  const calls = safeAggregateNumber(row.calls, 'event count');
  return {
    tokens: {
      in: safeAggregateNumber(row.tokens_in, 'input tokens'),
      out: safeAggregateNumber(row.tokens_out, 'output tokens'),
      cache_read: safeAggregateNumber(row.tokens_cache_read, 'cache-read tokens'),
      cache_write: safeAggregateNumber(row.tokens_cache_write, 'cache-write tokens'),
      reasoning: safeAggregateNumber(row.tokens_reasoning, 'reasoning tokens'),
      unattributed: safeAggregateNumber(row.tokens_unattributed, 'unattributed tokens')
    },
    calls,
    sources: row.sources || [],
    evidence: {
      tokenDetail: unknownTokenCategories.length ? 'partial' : 'exact',
      modelIdentity: !calls ? 'unknown' : (unknownModels ? (knownModels ? 'partial' : 'unknown') : 'exact'),
      unknownTokenCategories,
      providerEventReconciliation: 'unknown',
      accountWindow: 'unknown'
    },
    openrouterEquivalent: {
      label: OPENROUTER_EQUIVALENT_LABEL,
      amount,
      flatAmount,
      status,
      unpricedModels: row.unpriced_models || [],
      version: row.pricing_catalogue_version || pricing.snapshot.version
    }
  };
}

const FLEET_AGGREGATES = `
  count(*)::text AS calls,
  COALESCE(sum((e.tokens->>'in')::numeric), 0)::text AS tokens_in,
  COALESCE(sum((e.tokens->>'out')::numeric), 0)::text AS tokens_out,
  COALESCE(sum((e.tokens->>'cache_read')::numeric), 0)::text AS tokens_cache_read,
  COALESCE(sum((e.tokens->>'cache_write')::numeric), 0)::text AS tokens_cache_write,
  COALESCE(sum((e.tokens->>'reasoning')::numeric), 0)::text AS tokens_reasoning,
  COALESCE(sum((e.tokens->>'unattributed')::numeric), 0)::text AS tokens_unattributed,
  COALESCE(bool_or(COALESCE(e.tokens->'missing', '[]'::jsonb) ? 'in'), false) AS missing_in,
  COALESCE(bool_or(COALESCE(e.tokens->'missing', '[]'::jsonb) ? 'out'), false) AS missing_out,
  COALESCE(bool_or(COALESCE(e.tokens->'missing', '[]'::jsonb) ? 'cache_read'), false) AS missing_cache_read,
  COALESCE(bool_or(COALESCE(e.tokens->'missing', '[]'::jsonb) ? 'cache_write'), false) AS missing_cache_write,
  count(*) FILTER (WHERE e.model IS NOT NULL AND e.model <> '' AND e.model <> 'unknown')::text AS known_models,
  count(*) FILTER (WHERE e.model IS NULL OR e.model = '' OR e.model = 'unknown')::text AS unknown_models,
  CASE
    WHEN count(*) FILTER (WHERE e.pricing_status <> 'unknown') = 0
         AND count(*) FILTER (WHERE e.pricing_status = 'unknown') > 0 THEN NULL
    ELSE COALESCE(sum(e.pricing_amount) FILTER (WHERE e.pricing_status <> 'unknown'), 0)::text
  END AS pricing_amount,
  CASE
    WHEN count(*) FILTER (WHERE e.pricing_status <> 'unknown') = 0
         AND count(*) FILTER (WHERE e.pricing_status = 'unknown') > 0 THEN NULL
    ELSE COALESCE(sum(e.pricing_flat_amount) FILTER (WHERE e.pricing_status <> 'unknown'), 0)::text
  END AS pricing_flat_amount,
  CASE
    WHEN count(*) FILTER (WHERE e.pricing_status = 'unknown') > 0
         AND count(*) FILTER (WHERE e.pricing_status <> 'unknown') > 0 THEN 'partial'
    WHEN count(*) > 0 AND count(*) FILTER (WHERE e.pricing_status = 'unknown') = count(*) THEN 'unknown'
    WHEN count(*) FILTER (WHERE e.pricing_status = 'partial') > 0 THEN 'partial'
    ELSE 'priced'
  END AS pricing_status,
  COALESCE(
    (array_agg(e.pricing_catalogue_version ORDER BY e.occurred_at DESC)
      FILTER (WHERE e.pricing_catalogue_version IS NOT NULL))[1],
    NULL
  ) AS pricing_catalogue_version,
  COALESCE(array_agg(DISTINCT e.source ORDER BY e.source)
    FILTER (WHERE e.source IS NOT NULL), ARRAY[]::text[]) AS sources,
  COALESCE(array_agg(DISTINCT e.pricing_unpriced_model ORDER BY e.pricing_unpriced_model)
    FILTER (WHERE e.pricing_unpriced_model IS NOT NULL), ARRAY[]::text[]) AS unpriced_models`;

async function aggregateFleet(pool, where, values, keyExpression, labelExpression, limit) {
  const selectKey = keyExpression ? keyExpression + ' AS bucket_key, ' : '';
  const selectLabel = labelExpression ? labelExpression + ' AS bucket_label, ' : '';
  const group = keyExpression ? ' GROUP BY ' + keyExpression : '';
  const orderLimit = keyExpression ? ` ORDER BY ${keyExpression} LIMIT ${limit + 1}` : '';
  const result = await pool.query(
    `SELECT ${selectKey}${selectLabel}${FLEET_AGGREGATES}
       FROM usage_events e
       JOIN devices d ON d.owner_user_id=e.owner_user_id AND d.id=e.device_id
      WHERE ${where}${group}${orderLimit}`, values
  );
  return { rows: result.rows.slice(0, limit || result.rows.length), truncated: !!limit && result.rowCount > limit };
}

async function fleet(pool, manager, options) {
  const identity = await managerIdentity(pool, manager);
  if (!identity) throw Object.assign(new Error('manager is not authorized'), { statusCode: 403 });
  const requested = typeof options === 'object' && options ? options : { days: options };
  const countDays = Math.min(365, Math.max(1, Number(requested.days) || 30));
  const deviceId = requested.deviceId == null || requested.deviceId === '' ? null : String(requested.deviceId);
  const harness = requested.harness == null || requested.harness === '' ? null : String(requested.harness).trim();
  if (deviceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw Object.assign(new Error('invalid device filter'), { statusCode: 400 });
  }
  if (harness && (harness.length > 64 || EVENT_CONTROL_CHARACTERS.test(harness))) {
    throw Object.assign(new Error('invalid tool filter'), { statusCode: 400 });
  }
  const values = [manager.companyId, countDays];
  let where = `e.company_id = $1 AND e.occurred_at >= now() - ($2 * interval '1 day')
    AND EXISTS (SELECT 1 FROM company_memberships visible_membership
      WHERE visible_membership.company_id=e.company_id
        AND visible_membership.user_id=e.owner_user_id
        AND visible_membership.revoked_at IS NULL)`;
  if (deviceId) { values.push(deviceId); where += ` AND e.device_id = $${values.length}`; }
  if (harness) { values.push(harness); where += ` AND e.harness = $${values.length}`; }
  const modelKey = "COALESCE(NULLIF(e.model, ''), '(unknown model)')";
  const [totalRows, deviceRows, harnessRows, modelRows, sourceRows, dayRows, devices] = await Promise.all([
    aggregateFleet(pool, where, values, null, null, 0),
    aggregateFleet(pool, where, values, 'e.device_id', 'max(d.label)', MAX_FLEET_DEVICES),
    aggregateFleet(pool, where, values, 'e.harness', null, MAX_FLEET_TOOLS),
    aggregateFleet(pool, where, values, modelKey, null, MAX_FLEET_MODELS),
    aggregateFleet(pool, where, values, 'e.source', null, MAX_FLEET_SOURCES),
    aggregateFleet(pool, where, values, "date_trunc('day', e.occurred_at)::date", null, 366),
    pool.query(
    `SELECT id, label, platform, created_at, last_seen_at, revoked_at,
            (revoked_at IS NULL AND last_seen_at > now() - interval '5 minutes') AS online
       FROM devices d WHERE d.company_id = $1
         AND EXISTS (SELECT 1 FROM company_memberships visible_membership
           WHERE visible_membership.company_id=d.company_id
             AND visible_membership.user_id=d.owner_user_id
             AND visible_membership.revoked_at IS NULL)
       ORDER BY created_at LIMIT $2`,
    [manager.companyId, MAX_FLEET_DEVICES + 1])
  ]);
  const total = bucketFromAggregate(totalRows.rows[0] || {
    tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0,
    tokens_reasoning: 0, tokens_unattributed: 0, calls: 0, pricing_amount: null,
    pricing_flat_amount: null, pricing_status: 'priced', unpriced_models: [], sources: [],
    known_models: 0, unknown_models: 0
  });
  const byDevice = {}, byHarness = {}, byModel = {}, bySource = {}, byDay = {};
  for (const row of deviceRows.rows) {
    const bucket = bucketFromAggregate(row); bucket.label = row.bucket_label; byDevice[row.bucket_key] = bucket;
  }
  for (const row of harnessRows.rows) {
    const bucket = bucketFromAggregate(row);
    // Multi-source aggregates: never promote client-supplied sources to verified.
    // Prefer the conservative task-row label when sources mix or look "official".
    const sources = bucket.sources || [];
    const onlyLocal = sources.length > 0 && sources.every((s) => {
      const n = String(s || '').toLowerCase().replace(/_/g, '-');
      return n === 'local-log' || n === 'local';
    });
    bucket.reporting = reportingLabelFor(
      row.bucket_key,
      onlyLocal ? (sources[0] || 'local_log') : null,
      { providerVerified: false }
    );
    byHarness[row.bucket_key] = bucket;
  }
  for (const row of modelRows.rows) {
    const bucket = bucketFromAggregate(row);
    bucket.reporting = reportingLabelFor(null, (bucket.sources || [])[0], { providerVerified: false });
    byModel[row.bucket_key] = bucket;
  }
  for (const row of sourceRows.rows) {
    const bucket = bucketFromAggregate(row);
    bucket.reporting = reportingLabelFor(null, row.bucket_key, { providerVerified: false });
    bySource[row.bucket_key] = bucket;
  }
  for (const row of dayRows.rows) byDay[String(row.bucket_key).slice(0, 10)] = bucketFromAggregate(row);
  const catalogue = pricing.catalogue();
  return {
    since: new Date(Date.now() - countDays * 86400000).toISOString().slice(0, 10),
    filters: { days: countDays, deviceId, harness },
    totalEvents: total.calls,
    total,
    moneyLabel: OPENROUTER_EQUIVALENT_LABEL,
    pricing: {
      version: catalogue.version,
      asOf: catalogue.asOf,
      label: OPENROUTER_EQUIVALENT_LABEL
    },
    reportingSurfaces: {
      // Honest policy text only. Uploaded rows are never labelled provider-accounted
      // from device-supplied harness/source; server-side reconciliation is not live.
      cursor: {
        uploadedRows: 'task counters',
        providerAccounted: 'not available until server-side provider reconciliation',
        note: 'Device-uploaded Cursor rows are task counters only. This service does not claim live provider matching.'
      },
      claude: {
        taskRows: 'task counters',
        accountWindow: 'separate from task rows'
      },
      codex: {
        taskRows: 'task counters',
        accountWindow: 'separate from task rows'
      },
      gemini: {
        taskRows: 'task counters',
        accountWindow: 'separate from task rows'
      },
      grok: {
        counters: 'local',
        note: 'Local session counters only; no provider usage export is claimed.'
      }
    },
    limits: {
      maxDevices: MAX_FLEET_DEVICES, maxTools: MAX_FLEET_TOOLS,
      maxModels: MAX_FLEET_MODELS, maxSources: MAX_FLEET_SOURCES,
      devicesTruncated: devices.rowCount > MAX_FLEET_DEVICES || deviceRows.truncated,
      toolsTruncated: harnessRows.truncated,
      modelsTruncated: modelRows.truncated,
      sourcesTruncated: sourceRows.truncated
    },
    devices: devices.rows.slice(0, MAX_FLEET_DEVICES).map((row) => ({
      id: row.id, label: row.label, platform: row.platform,
      createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at && row.last_seen_at.toISOString(),
      revokedAt: row.revoked_at && row.revoked_at.toISOString(), online: row.online
    })),
    byDevice, byHarness, byModel, bySource, byDay
  };
}

async function userFleet(pool, user, options) {
  const requested = typeof options === 'object' && options ? options : {};
  const countDays = Math.min(365, Math.max(1, Number(requested.days) || 30));
  const companyId = requested.companyId == null || requested.companyId === '' ? null : String(requested.companyId);
  const activeMembership = companyId ? await membership(pool, user.id, companyId) : null;
  if (companyId && !activeMembership) return null;
  const managesCompany = !!activeMembership && ['owner', 'administrator'].includes(activeMembership.role);
  const deviceId = requested.deviceId == null || requested.deviceId === '' ? null : String(requested.deviceId);
  const harness = requested.harness == null || requested.harness === '' ? null : String(requested.harness).trim();
  if (deviceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw Object.assign(new Error('invalid device filter'), { statusCode: 400 });
  }
  if (harness && (harness.length > 64 || EVENT_CONTROL_CHARACTERS.test(harness))) {
    throw Object.assign(new Error('invalid tool filter'), { statusCode: 400 });
  }
  const values = companyId
    ? (managesCompany ? [companyId, countDays] : [user.id, companyId, countDays])
    : [user.id, countDays];
  let where = companyId
    ? (managesCompany
      ? `e.company_id=$1 AND e.occurred_at >= now() - ($2 * interval '1 day')
         AND EXISTS (SELECT 1 FROM company_memberships active_scope
           WHERE active_scope.company_id=e.company_id
             AND active_scope.user_id=e.owner_user_id AND active_scope.revoked_at IS NULL)`
      : `e.owner_user_id=$1 AND e.company_id=$2 AND e.occurred_at >= now() - ($3 * interval '1 day')
         AND EXISTS (SELECT 1 FROM company_memberships active_scope
           WHERE active_scope.company_id=e.company_id AND active_scope.user_id=$1 AND active_scope.revoked_at IS NULL)`)
    : `e.owner_user_id=$1 AND e.company_id IS NULL AND e.occurred_at >= now() - ($2 * interval '1 day')`;
  if (deviceId) { values.push(deviceId); where += ` AND e.device_id = $${values.length}`; }
  if (harness) { values.push(harness); where += ` AND e.harness = $${values.length}`; }
  const deviceScopeValues = companyId
    ? (managesCompany ? [companyId, MAX_FLEET_DEVICES + 1] : [user.id, companyId, MAX_FLEET_DEVICES + 1])
    : [user.id, MAX_FLEET_DEVICES + 1];
  const deviceScope = companyId
    ? (managesCompany
      ? `d.company_id=$1 AND EXISTS (SELECT 1 FROM company_memberships active_scope
           WHERE active_scope.company_id=d.company_id
             AND active_scope.user_id=d.owner_user_id AND active_scope.revoked_at IS NULL)`
      : `d.owner_user_id=$1 AND d.company_id=$2
         AND EXISTS (SELECT 1 FROM company_memberships active_scope
           WHERE active_scope.company_id=d.company_id AND active_scope.user_id=$1 AND active_scope.revoked_at IS NULL)`)
    : 'd.owner_user_id=$1 AND d.company_id IS NULL';
  const [totalRows, deviceRows, harnessRows, dayRows, devices] = await Promise.all([
    aggregateFleet(pool, where, values, null, null, 0),
    aggregateFleet(pool, where, values, 'e.device_id', 'max(d.label)', MAX_FLEET_DEVICES),
    aggregateFleet(pool, where, values, 'e.harness', null, MAX_FLEET_TOOLS),
    aggregateFleet(pool, where, values, "date_trunc('day', e.occurred_at)::date", null, 366),
    pool.query(
      `SELECT d.id, d.label, d.platform, d.created_at, d.last_seen_at, d.revoked_at,
              (d.revoked_at IS NULL AND d.last_seen_at > now() - interval '5 minutes') AS online
         FROM devices d WHERE ${deviceScope} ORDER BY d.created_at LIMIT $${deviceScopeValues.length}`,
      deviceScopeValues)
  ]);
  const total = bucketFromAggregate(totalRows.rows[0]);
  const byDevice = {}, byHarness = {}, byDay = {};
  for (const row of deviceRows.rows) {
    const bucket = bucketFromAggregate(row); bucket.label = row.bucket_label; byDevice[row.bucket_key] = bucket;
  }
  for (const row of harnessRows.rows) byHarness[row.bucket_key] = bucketFromAggregate(row);
  for (const row of dayRows.rows) byDay[String(row.bucket_key).slice(0, 10)] = bucketFromAggregate(row);
  const catalogue = pricing.catalogue();
  return {
    scope: companyId ? { type: 'company', companyId } : { type: 'personal' },
    since: new Date(Date.now() - countDays * 86400000).toISOString().slice(0, 10),
    filters: { days: countDays, deviceId, harness }, totalEvents: total.calls, total,
    pricing: { version: catalogue.version, asOf: catalogue.asOf },
    limits: {
      maxDevices: MAX_FLEET_DEVICES, maxTools: MAX_FLEET_TOOLS,
      devicesTruncated: devices.rowCount > MAX_FLEET_DEVICES || deviceRows.truncated,
      toolsTruncated: harnessRows.truncated
    },
    devices: devices.rows.slice(0, MAX_FLEET_DEVICES).map((row) => ({
      id: row.id, label: row.label, platform: row.platform,
      createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at && row.last_seen_at.toISOString(),
      revokedAt: row.revoked_at && row.revoked_at.toISOString(), online: row.online
    })),
    byDevice, byHarness, byDay
  };
}

async function revokeDevice(pool, manager, deviceId) {
  const identity = await managerIdentity(pool, manager);
  if (!identity) return null;
  const changed = await pool.query(
    `UPDATE devices d SET revoked_at=COALESCE(d.revoked_at, now()), credential_hash=NULL
      WHERE d.company_id=$1 AND d.id=$2
        AND EXISTS (SELECT 1 FROM company_memberships owner_membership
          WHERE owner_membership.company_id=d.company_id
            AND owner_membership.user_id=d.owner_user_id
            AND owner_membership.revoked_at IS NULL)
      RETURNING d.id, d.revoked_at`, [manager.companyId, deviceId]
  );
  if (!changed.rowCount) return null;
  await pool.query(
    `INSERT INTO audit_facts(company_id, actor_type, actor_id, action, subject_id, outcome)
     VALUES ($1, 'manager', $2, 'device.revoke', $3, 'allowed')`,
    [manager.companyId, manager.id, deviceId]
  );
  return { id: changed.rows[0].id, revokedAt: changed.rows[0].revoked_at.toISOString() };
}

module.exports = {
  createPool, migrate, bootstrapCompany, loginManager, managerByToken, deviceByToken,
  managerCsrfMatches, rotateManagerCsrf, logoutManager,
  createUser, loginUser, userByToken, userCsrfMatches, rotateUserCsrf, logoutUser,
  membership, listMemberships, addMembership, removeMembership,
  consumeRateLimit, purgeOperationalFacts, readiness, refreshEventPricing,
  eventPricing, createEnrollment, createUserEnrollment, enrollDevice, sanitizeEvent, storeEvents,
  fleet, userFleet, revokeDevice
};
