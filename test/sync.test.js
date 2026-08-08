'use strict';

// The fleet sync suite now exercises the real PostgreSQL repository, company
// authentication and HTTP boundary together.
// Transport behaviour first: it needs no database, so a missing test database
// cannot hide a regression in expired-link or held-back-event handling. It runs
// as its own process because it points the store at a throwaway data directory,
// which must not leak into the database suite below. A non-zero exit throws.
require('child_process').execFileSync(
  process.execPath,
  [require.resolve('./sync-transport.test.js')],
  { stdio: 'inherit' }
);

require('./security.test');
