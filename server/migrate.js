#!/usr/bin/env node
'use strict';

const repository = require('./repository');

(async () => {
  const pool = repository.createPool();
  try {
    const applied = await repository.migrate(pool);
    console.log('Database schema ready (' + applied.length + ' ordered migrations)');
  } finally {
    await pool.end();
  }
})().catch(() => {
  console.error('Database migration failed; check DATABASE_URL and database permissions');
  process.exit(1);
});
