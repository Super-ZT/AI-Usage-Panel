'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SECRET_FILE_BYTES = 64 * 1024;
const REQUIRED_PRODUCTION_KEYS = Object.freeze(['DATABASE_URL', 'RATE_LIMIT_SECRET']);
const ALLOWED_SECRET_KEYS = new Set([
  'DATABASE_URL', 'RESTORE_DATABASE_URL', 'RATE_LIMIT_SECRET',
  'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DATABASE', 'RESTORE_POSTGRES_DATABASE',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'BACKUP_RECIPIENT', 'BACKUP_IDENTITY_FILE'
]);

function parseSecretFile(raw) {
  const values = {};
  for (const [index, source] of String(raw).split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split < 1) throw new Error('invalid secret-file entry on line ' + (index + 1));
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('invalid secret-file key on line ' + (index + 1));
    if (!ALLOWED_SECRET_KEYS.has(key)) throw new Error('unsupported secret-file key: ' + key);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error('duplicate secret-file key: ' + key);
    if (/\u0000|\r|\n/.test(value)) throw new Error('invalid secret-file value: ' + key);
    values[key] = value;
  }
  return values;
}

function loadExternalSecrets(file, target) {
  if (!file || !path.isAbsolute(file)) throw new Error('USAGE_PANEL_SECRETS_FILE must be an absolute path');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('USAGE_PANEL_SECRETS_FILE must not be a symbolic link');
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('USAGE_PANEL_SECRETS_FILE must name a regular file');
  if (stat.size > MAX_SECRET_FILE_BYTES) throw new Error('USAGE_PANEL_SECRETS_FILE is too large');
  // Docker projects a host root-only secret into /run/secrets as a read-only
  // file. Outside that projection, reject group/world-readable source files.
  if (!file.startsWith('/run/secrets/') && (stat.mode & 0o077)) {
    throw new Error('USAGE_PANEL_SECRETS_FILE must be owner-only (mode 0600)');
  }
  const values = parseSecretFile(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) target[key] = value;
  return Object.keys(values);
}

function requireProductionSecrets(target) {
  for (const key of REQUIRED_PRODUCTION_KEYS) {
    if (typeof target[key] !== 'string' || !target[key].trim()) throw new Error(key + ' is required and must not be empty');
  }
  if (!/^postgres(?:ql)?:\/\//.test(target.DATABASE_URL)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  if (target.RATE_LIMIT_SECRET.length < 32) throw new Error('RATE_LIMIT_SECRET must contain at least 32 characters');
}

function loadRuntimeConfig(target) {
  const env = target || process.env;
  if (env.USAGE_PANEL_SECRETS_FILE) loadExternalSecrets(env.USAGE_PANEL_SECRETS_FILE, env);
  if (env.USAGE_PANEL_REQUIRE_SECRETS === '1') requireProductionSecrets(env);
  return env;
}

loadRuntimeConfig(process.env);

module.exports = {
  MAX_SECRET_FILE_BYTES, REQUIRED_PRODUCTION_KEYS, ALLOWED_SECRET_KEYS,
  parseSecretFile, loadExternalSecrets, requireProductionSecrets, loadRuntimeConfig
};
