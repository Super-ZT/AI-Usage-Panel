'use strict';

const repository = require('/app/server/repository');

(async () => {
  const pool = repository.createPool();
  try {
    await repository.readiness(pool);
    const created = await repository.bootstrapCompany(pool, {
      slug: 'offline-validation', name: 'Offline Validation', email: 'offline@example.test',
      password: 'offline validation password'
    });
    const manager = { id: created.manager.id, companyId: created.company.id };
    const other = await repository.bootstrapCompany(pool, {
      slug: 'offline-isolation', name: 'Offline Isolation', email: 'isolation@example.test',
      password: 'offline isolation password'
    });
    const otherManager = { id: other.manager.id, companyId: other.company.id };
    const firstCode = await repository.createEnrollment(pool, manager, 15);
    const secondCode = await repository.createEnrollment(pool, manager, 15);
    const first = await repository.enrollDevice(pool, { code: firstCode.code, label: 'duplicate-label', platform: 'stack' });
    const second = await repository.enrollDevice(pool, { code: secondCode.code, label: 'duplicate-label', platform: 'stack' });
    const otherCode = await repository.createEnrollment(pool, otherManager, 15);
    const otherDevice = await repository.enrollDevice(pool, {
      code: otherCode.code, label: 'foreign-device', platform: 'stack'
    });
    await repository.storeEvents(pool, first.device, [{
      event_id: 'stack-known-event-0001', harness: 'claude-code', provider: 'stack',
      model: 'anthropic/claude-opus-4.6', pricing_model: 'anthropic/claude-opus-4.6',
      ts: new Date().toISOString(), tokens: { in: 100, out: 20, cache_read: 30, cache_write: 5 }, source: 'local-log'
    }, {
      event_id: 'stack-unknown-event-01', harness: 'mystery-tool', provider: 'stack',
      model: 'does-not-exist/model', pricing_model: 'does-not-exist/model',
      ts: new Date().toISOString(), tokens: { in: 7, out: 3 }, source: 'local-log'
    }]);
    await repository.storeEvents(pool, second.device, [{
      event_id: 'stack-second-event-01', harness: 'codex', provider: 'stack',
      model: 'openai/gpt-5.2', pricing_model: 'openai/gpt-5.2',
      ts: new Date().toISOString(), tokens: { in: 50, out: 10 }, source: 'local-log'
    }]);
    await repository.storeEvents(pool, otherDevice.device, [{
      event_id: 'stack-foreign-event-01', harness: 'codex', provider: 'stack',
      model: 'openai/gpt-5.2', pricing_model: 'openai/gpt-5.2',
      ts: new Date().toISOString(), tokens: { in: 999, out: 99 }, source: 'local-log'
    }]);
    const login = await repository.loginManager(pool, {
      email: 'offline@example.test', password: 'offline validation password'
    });
    if (!login) throw new Error('validation manager login failed');
    const userLogin = await repository.loginUser(pool, {
      email: 'offline@example.test', password: 'offline validation password'
    });
    if (!userLogin) throw new Error('validation user login failed');
    const summary = await pool.query(
      `SELECT (SELECT count(*)::int FROM companies) AS companies,
              (SELECT count(*)::int FROM devices) AS devices,
              (SELECT count(*)::int FROM usage_events) AS events,
              (SELECT count(*)::int FROM manager_sessions WHERE revoked_at IS NULL) AS active_sessions,
              (SELECT count(*)::int FROM user_sessions WHERE revoked_at IS NULL) AS active_user_sessions`
    );
    console.log(JSON.stringify(summary.rows[0]));
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
