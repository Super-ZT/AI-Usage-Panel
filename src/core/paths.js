'use strict';

/**
 * Cross-platform application paths.
 *
 * No user-specific paths are hardcoded anywhere in this project: everything is
 * derived from the OS conventions below, or overridden via config.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'usage-panel';

/**
 * Per-user data directory following each platform's convention.
 * @returns {string} absolute path (not guaranteed to exist yet)
 */
function dataDir() {
  if (process.env.USAGE_PANEL_DATA_DIR) return process.env.USAGE_PANEL_DATA_DIR;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_NAME);
  }
}

/**
 * Per-user config directory following each platform's convention.
 * @returns {string} absolute path (not guaranteed to exist yet)
 */
function configDir() {
  if (process.env.USAGE_PANEL_CONFIG_DIR) return process.env.USAGE_PANEL_CONFIG_DIR;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  }
}

/**
 * Create a directory (recursively) if it does not exist.
 * @param {string} dir
 * @returns {string} the same path, for chaining
 */
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return dir;
}

/** Create an owner-only directory for credentials and installation identity. */
function ensurePrivateDir(dir) {
  ensureDir(dir);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private runtime path is not a directory');
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* Windows ACLs apply instead */ }
  return dir;
}

/**
 * Expand a leading `~` and resolve to an absolute path.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * First existing path from a list of candidates.
 * @param {string[]} candidates
 * @returns {string|null}
 */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const resolved = expandHome(c);
    try {
      if (fs.existsSync(resolved)) return resolved;
    } catch (_) { /* unreadable candidate: treat as missing */ }
  }
  return null;
}

module.exports = { APP_NAME, dataDir, configDir, ensureDir, ensurePrivateDir, expandHome, firstExisting };
