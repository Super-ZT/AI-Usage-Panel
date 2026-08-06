'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL must point to a disposable PostgreSQL database');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const repository = require('../server/repository');
const security = require('../server/security');
const config = require('../server/config');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  FAIL ' + name + '\n       ' + err.message); }
}

function event(id, device, days, harness, model, tokens) {
  return {
    event_id: id, device_id: device.id, harness, provider: 'test', model, pricing_model: model,
    ts: new Date(Date.now() - days * 86400000).toISOString(), tokens, source: 'local-log'
  };
}

(async () => {
  console.log('offline operations / PostgreSQL tests\n');
  const pool = repository.createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const migrationDir = path.join(__dirname, '..', 'server', 'migrations');
  for (const name of ['001_company_security.sql', '002_indexes.sql', '003_manager_dashboard.sql']) {
    await pool.query(fs.readFileSync(path.join(migrationDir, name), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
  }
  const legacyPassword = await security.hashPassword('offline legacy operations password');
  const legacyCompany = (await pool.query(
    `INSERT INTO companies(slug,name) VALUES ('legacy-operations','Legacy Operations') RETURNING id,slug,name`
  )).rows[0];
  const legacyManager = (await pool.query(
    `INSERT INTO managers(company_id,email,password_salt,password_hash,password_params)
     VALUES ($1,'legacy-operations@example.test',$2,$3,$4::jsonb) RETURNING id,email`,
    [legacyCompany.id, legacyPassword.salt, legacyPassword.hash, JSON.stringify(legacyPassword.params)]
  )).rows[0];
  const legacyDevice = (await pool.query(
    `INSERT INTO devices(company_id,label,platform,credential_hash)
     VALUES ($1,'pre-operations-device','test',$2) RETURNING id,company_id`,
    [legacyCompany.id, security.tokenHash('upd_legacy_operations')]
  )).rows[0];
  await pool.query(
    `INSERT INTO enrollment_codes(company_id,code_hash,created_by_manager_id,expires_at,used_at,used_by_device_id)
     VALUES ($1,$2,$3,now()+interval '15 minutes',now(),$4)`,
    [legacyCompany.id, security.tokenHash('upe_legacy_operations'), legacyManager.id, legacyDevice.id]
  );
  await pool.query(
    `INSERT INTO usage_events(company_id,event_id,device_id,harness,provider,model,pricing_model,occurred_at,tokens,source)
     VALUES ($1,'pre-operations-event-01',$2,'codex','test','openai/gpt-5.2','openai/gpt-5.2',now(),$3::jsonb,'local-log')`,
    [legacyCompany.id, legacyDevice.id, JSON.stringify({ in: 12, out: 3 })]
  );
  const migrations = await repository.migrate(pool);
  const company = await repository.bootstrapCompany(pool, {
    slug: 'operations', name: 'Operations Test', email: 'operations@example.test',
    password: 'offline operations password'
  });
  const manager = { id: company.manager.id, companyId: company.company.id };
  const enrollmentA = await repository.createEnrollment(pool, manager, 15);
  const enrollmentB = await repository.createEnrollment(pool, manager, 15);
  const deviceA = (await repository.enrollDevice(pool, { code: enrollmentA.code, label: 'same-label', platform: 'test' })).device;
  const deviceB = (await repository.enrollDevice(pool, { code: enrollmentB.code, label: 'same-label', platform: 'test' })).device;

  await test('production secret loader requires owner-only non-empty values without interpolation', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-config-'));
    const file = path.join(scratch, 'secrets.env');
    fs.writeFileSync(file, 'DATABASE_URL=postgresql://example.invalid/db\nRATE_LIMIT_SECRET=' + 'x'.repeat(32) + '\n');
    fs.chmodSync(file, 0o600);
    const target = {};
    assert.deepStrictEqual(config.loadExternalSecrets(file, target), ['DATABASE_URL', 'RATE_LIMIT_SECRET']);
    assert.doesNotThrow(() => config.requireProductionSecrets(target));
    fs.chmodSync(file, 0o644);
    assert.throws(() => config.loadExternalSecrets(file, {}), /owner-only/);
    const link = path.join(scratch, 'secrets-link.env');
    fs.symlinkSync(file, link);
    assert.throws(() => config.loadExternalSecrets(link, {}), /symbolic link/);
    assert.throws(() => config.requireProductionSecrets({ DATABASE_URL: '', RATE_LIMIT_SECRET: '' }), /DATABASE_URL/);
    assert.throws(() => config.parseSecretFile('NODE_OPTIONS=--inspect\n'), /unsupported/);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await test('ordered migrations are idempotent and readiness includes pricing refresh', async () => {
    assert.deepStrictEqual(migrations, ['001_company_security.sql', '002_indexes.sql', '003_manager_dashboard.sql',
      '004_operations_readiness.sql', '005_operations_constraints.sql', '006_user_accounts.sql']);
    assert.deepStrictEqual(await repository.migrate(pool), migrations);
    const ready = await repository.readiness(pool);
    assert.strictEqual(ready.migrations, 6); assert.match(ready.pricingVersion, /^openrouter-/);
    const backfilled = await pool.query(
      `SELECT pricing_status,pricing_amount,pricing_catalogue_version
         FROM usage_events WHERE company_id=$1 AND event_id='pre-operations-event-01'`,
      [legacyCompany.id]
    );
    assert.strictEqual(backfilled.rows[0].pricing_status, 'priced');
    assert.ok(Number(backfilled.rows[0].pricing_amount) > 0);
    assert.strictEqual(backfilled.rows[0].pricing_catalogue_version, ready.pricingVersion);
  });

  await test('database-shared rate limits are enforced without storing source identity', async () => {
    const key = security.keyedHash('test-secret', 'manager-login\0source-address');
    const global = security.keyedHash('test-secret', 'global\0manager-login');
    assert.strictEqual(await repository.consumeRateLimit(pool, key, global, 2, 10, Date.now()), true);
    assert.strictEqual(await repository.consumeRateLimit(pool, key, global, 2, 10, Date.now()), true);
    assert.strictEqual(await repository.consumeRateLimit(pool, key, global, 2, 10, Date.now()), false);
    const stored = await pool.query('SELECT key_hash,request_count FROM api_rate_limits');
    assert.ok(stored.rows.every((row) => Buffer.isBuffer(row.key_hash)));
    assert.ok(!JSON.stringify(stored.rows).includes('source-address'));
  });

  await test('one-year totals use bounded SQL aggregates and preserve filters and unknown pricing', async () => {
    const storedA = await repository.storeEvents(pool, deviceA, [
      event('operations-known-0001', deviceA, 1, 'claude-code', 'anthropic/claude-opus-4.6',
        { in: 100, out: 20, cache_read: 30, cache_write: 5 }),
      event('operations-unknown-01', deviceA, 8, 'mystery-tool', 'does-not-exist/model', { in: 7, out: 3 }),
      event('operations-old-000001', deviceA, 120, 'codex', 'openai/gpt-5.2', { in: 900, out: 90 })
    ]);
    const storedB = await repository.storeEvents(pool, deviceB, [
      event('operations-device-b1', deviceB, 2, 'claude-code', 'anthropic/claude-opus-4.6', { in: 50, out: 10 })
    ]);
    assert.strictEqual(storedA.accepted.length, 3); assert.strictEqual(storedB.accepted.length, 1);
    const statements = [];
    const observedPool = {
      query(text, values) { statements.push(String(text)); return pool.query(text, values); }
    };
    const year = await repository.fleet(observedPool, manager, { days: 365 });
    assert.strictEqual(year.totalEvents, 4);
    assert.deepStrictEqual(year.total.tokens, {
      in: 1057, out: 123, cache_read: 30, cache_write: 5, reasoning: 0, unattributed: 0
    });
    assert.strictEqual(year.total.openrouterEquivalent.status, 'partial');
    assert.deepStrictEqual(year.total.openrouterEquivalent.unpricedModels, ['does-not-exist/model']);
    assert.strictEqual(year.devices.filter((row) => row.label === 'same-label').length, 2);
    const filtered = await repository.fleet(pool, manager, { days: 30, deviceId: deviceA.id, harness: 'claude-code' });
    assert.strictEqual(filtered.totalEvents, 1); assert.strictEqual(filtered.total.tokens.in, 100);
    assert.ok(statements.some((sql) => /sum\(\(e\.tokens->>'in'\)::numeric\)/.test(sql)));
    assert.ok(statements.every((sql) => !/SELECT\s+e\.\*/i.test(sql)));
    assert.strictEqual(year.limits.devicesTruncated, false); assert.strictEqual(year.limits.toolsTruncated, false);
  });

  await test('retention removes old and excess operational facts but never usage events', async () => {
    const usageBefore = Number((await pool.query('SELECT count(*) FROM usage_events')).rows[0].count);
    await pool.query(
      `INSERT INTO usage_rejections(company_id,owner_user_id,device_id,event_id,reason,created_at)
       SELECT $1,$2,$3,'retention-'||n,'test rejection',
              CASE WHEN n=1 THEN now()-interval '40 days' ELSE now() END
         FROM generate_series(1,1005) n`, [company.company.id, company.user.id, deviceA.id]
    );
    await pool.query(
      `INSERT INTO audit_facts(company_id,actor_type,actor_id,action,outcome,created_at)
       SELECT $1,'system',$2,'retention.test','allowed',
              CASE WHEN n=1 THEN now()-interval '200 days' ELSE now() END
         FROM generate_series(1,1005) n`, [company.company.id, company.manager.id]
    );
    const removed = await repository.purgeOperationalFacts(pool, {
      rejectionDays: 30, auditDays: 180, rejectionCap: 1000, auditCap: 1000
    });
    assert.ok(removed.usageRejections >= 5); assert.ok(removed.auditFacts >= 5);
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM usage_rejections')).rows[0].count), 1000);
    assert.ok(Number((await pool.query('SELECT count(*) FROM audit_facts WHERE company_id=$1', [company.company.id])).rows[0].count) <= 1000);
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM usage_events')).rows[0].count), usageBefore);
  });

  await pool.end();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const failure of failures) console.log('\n' + failure.name + '\n' + failure.err.stack);
    process.exit(1);
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
