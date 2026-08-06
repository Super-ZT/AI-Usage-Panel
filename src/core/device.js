'use strict';

/**
 * Stable per-installation device identity.
 *
 * Usage events are attributed to a device so a central collector can merge
 * several machines without double-counting. The identifier is random and
 * generated locally — it carries no personal data and never leaves the device
 * except as an opaque label on usage events.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { dataDir, ensurePrivateDir } = require('./paths');

/** @type {{id:string,label:string,platform:string}|null} */
let cached = null;

/**
 * Sanitise a hostname into a short human-readable label.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return String(name || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'device';
}

/**
 * Read (or create on first run) this installation's identity.
 *
 * @param {string} [overrideLabel] friendly name from config, if the user set one
 * @returns {{id:string,label:string,platform:string}}
 */
function identity(overrideLabel) {
  if (cached && !overrideLabel) return cached;

  const file = path.join(dataDir(), 'device.json');
  let record = null;
  try { ensurePrivateDir(dataDir()); } catch (_) { /* read-only install: use best effort below */ }
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACLs apply instead */ }
  } catch (_) { /* first run, or unreadable: regenerate below */ }

  if (!record || typeof record.id !== 'string' || record.id.length < 8) {
    record = {
      id: crypto.randomUUID(),
      label: slugify(os.hostname()),
      createdAt: new Date().toISOString()
    };
    try {
      ensurePrivateDir(dataDir());
      // Write atomically: a torn device.json would be regenerated with a new
      // id on the next start, and a central collector would then count this
      // machine twice and split its history.
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACLs apply instead */ }
    } catch (_) { /* read-only install: fall back to an in-memory identity */ }
  }

  cached = {
    id: record.id,
    label: overrideLabel ? slugify(overrideLabel) : (record.label || slugify(os.hostname())),
    platform: process.platform
  };
  return cached;
}

module.exports = { identity, slugify };
