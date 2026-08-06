'use strict';

const repository = require('./repository');
const { retentionOptions } = require('./collector');

(async () => {
  const pool = repository.createPool();
  try {
    await repository.readiness(pool);
    const removed = await repository.purgeOperationalFacts(pool, retentionOptions());
    console.log(JSON.stringify({ ok: true, removed }));
  } finally {
    await pool.end();
  }
})().catch(() => {
  console.error('Operational retention failed');
  process.exit(1);
});
