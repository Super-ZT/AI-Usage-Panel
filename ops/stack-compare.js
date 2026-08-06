'use strict';

const assert = require('assert');
const { Pool } = require('pg');

async function snapshot(pool) {
  const counts = (await pool.query(
    `SELECT (SELECT count(*)::int FROM companies) AS companies,
            (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM company_memberships) AS memberships,
            (SELECT count(*)::int FROM managers) AS managers,
            (SELECT count(*)::int FROM devices) AS devices,
            (SELECT count(*)::int FROM usage_events) AS events,
            (SELECT count(*)::int FROM manager_sessions WHERE revoked_at IS NULL) AS active_sessions,
            (SELECT count(*)::int FROM user_sessions WHERE revoked_at IS NULL) AS active_user_sessions,
            (SELECT count(*)::int FROM devices WHERE credential_hash IS NOT NULL AND revoked_at IS NULL) AS active_credentials`
  )).rows[0];
  const totals = (await pool.query(
    `SELECT count(*)::int AS events,
            COALESCE(sum((tokens->>'in')::bigint),0)::text AS input,
            COALESCE(sum((tokens->>'out')::bigint),0)::text AS output,
            COALESCE(sum((tokens->>'cache_read')::bigint),0)::text AS cache_read,
            COALESCE(sum((tokens->>'cache_write')::bigint),0)::text AS cache_write,
            COALESCE(sum(pricing_amount) FILTER (WHERE pricing_amount IS NOT NULL),0)::text AS priced_amount
       FROM usage_events`
  )).rows[0];
  const constraints = (await pool.query(
    `SELECT c.conname, c.contype, c.conrelid::regclass::text AS relation
       FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='public' ORDER BY relation,c.conname`
  )).rows;
  const migrations = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((row) => row.name);
  return { counts, totals, constraints, migrations };
}

(async () => {
  const source = new Pool({ connectionString: process.env.DATABASE_URL });
  const restored = new Pool({ connectionString: process.env.RESTORE_DATABASE_URL });
  try {
    const before = await snapshot(source);
    const after = await snapshot(restored);
    assert.deepStrictEqual(after.totals, before.totals);
    assert.deepStrictEqual(after.constraints, before.constraints);
    assert.deepStrictEqual(after.migrations, before.migrations);
    assert.strictEqual(after.counts.companies, before.counts.companies);
    assert.strictEqual(after.counts.users, before.counts.users);
    assert.strictEqual(after.counts.memberships, before.counts.memberships);
    assert.strictEqual(after.counts.managers, before.counts.managers);
    assert.strictEqual(after.counts.devices, before.counts.devices);
    assert.strictEqual(after.counts.events, before.counts.events);
    assert.ok(before.counts.active_sessions > 0); assert.ok(before.counts.active_user_sessions > 0);
    assert.ok(before.counts.active_credentials > 0);
    assert.strictEqual(after.counts.active_sessions, 0); assert.strictEqual(after.counts.active_credentials, 0);
    assert.strictEqual(after.counts.active_user_sessions, 0);
    console.log(JSON.stringify({
      durableCounts: after.counts,
      durableTotals: after.totals,
      constraints: after.constraints.length,
      migrations: after.migrations.length,
      restoredActiveSessions: after.counts.active_sessions,
      restoredActiveCredentials: after.counts.active_credentials
    }));
  } finally {
    await source.end(); await restored.end();
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
