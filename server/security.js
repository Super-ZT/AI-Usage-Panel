'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PASSWORD_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

function randomToken(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest();
}

function tokenMatches(raw, expectedHash) {
  if (!Buffer.isBuffer(expectedHash)) return false;
  const actual = tokenHash(raw);
  return actual.length === expectedHash.length && crypto.timingSafeEqual(actual, expectedHash);
}

function keyedHash(secret, value) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(value || ''), 'utf8').digest();
}

async function passwordDigest(password, salt, params) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('password must contain 12 to 1024 characters');
  }
  const p = Object.assign({}, PASSWORD_PARAMS, params || {});
  return scrypt(password, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await passwordDigest(password, salt, PASSWORD_PARAMS);
  return { salt, hash, params: PASSWORD_PARAMS };
}

async function verifyPassword(password, salt, expected, params) {
  try {
    const actual = await passwordDigest(password, salt, params);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

module.exports = { PASSWORD_PARAMS, randomToken, tokenHash, tokenMatches, keyedHash, hashPassword, verifyPassword };
