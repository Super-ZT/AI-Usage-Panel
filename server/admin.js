#!/usr/bin/env node
'use strict';

const repository = require('./repository');

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function stdinText() {
  if (process.stdin.isTTY) throw new Error('password must be piped on stdin');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      value += chunk;
      if (value.length > 2048) reject(new Error('password input too large'));
    });
    process.stdin.on('end', () => resolve(value.replace(/[\r\n]+$/, '')));
    process.stdin.on('error', reject);
  });
}

(async () => {
  const command = process.argv[2];
  if (!['bootstrap-company', 'create-user'].includes(command)) {
    throw new Error('usage: node server/admin.js bootstrap-company --slug SLUG --name NAME --email EMAIL < password.txt\n'
      + '   or: node server/admin.js create-user --email EMAIL < password.txt');
  }
  const password = await stdinText();
  const pool = repository.createPool();
  try {
    await repository.migrate(pool);
    if (command === 'create-user') {
      const created = await repository.createUser(pool, { email: arg('email'), password });
      console.log('User account created: ' + created.email);
      return;
    }
    const created = await repository.bootstrapCompany(pool, {
      slug: arg('slug'), name: arg('name'), email: arg('email'), password
    });
    console.log('Company and first manager created: ' + created.company.slug + ' / ' + created.manager.email);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err && err.message ? err.message : 'bootstrap failed');
  process.exit(1);
});
