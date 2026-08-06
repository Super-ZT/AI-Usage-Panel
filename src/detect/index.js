'use strict';

/**
 * Universal harness detection.
 *
 * Scans the machine for any known coding harness and reports what is installed,
 * where its data lives, and how usage can be captured from it. Works on any PC
 * with no per-machine configuration: PATH lookup uses each platform's own
 * conventions and directory candidates are expanded from the user's home.
 *
 * The result drives onboarding — for every bring-your-own-key harness it also
 * emits the exact environment needed to route it through the capture proxy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandHome } = require('../core/paths');
const registry = require('./registry');

/**
 * Locate an executable on PATH, honouring PATHEXT on Windows.
 * @param {string} name
 * @returns {string|null} absolute path, or null when not found
 */
function whichSync(name) {
  const isWindows = process.platform === 'win32';
  const pathVar = process.env.PATH || process.env.Path || '';
  const dirs = pathVar.split(isWindows ? ';' : ':').filter(Boolean);
  const exts = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch (_) { /* not here */ }
    }
  }
  return null;
}

/**
 * Resolve a harness's data directory.
 * Order: explicit override → environment variable → registry candidates.
 *
 * @param {import('./registry').HarnessSignature} sig
 * @param {string} [override] path from user config
 * @returns {{path:string, source:string}|null}
 */
function resolveHome(sig, override) {
  /** @type {Array<{path:string, source:string}>} */
  const candidates = [];
  if (override) candidates.push({ path: expandHome(override), source: 'config' });
  if (sig.envHome && process.env[sig.envHome]) {
    candidates.push({ path: expandHome(process.env[sig.envHome]), source: 'env:' + sig.envHome });
  }
  for (const home of sig.homes || []) candidates.push({ path: expandHome(home), source: 'default' });

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate.path)) continue;
      // A marker file distinguishes a real data directory from an empty stub
      // left behind by an uninstall.
      if (sig.marker && !fs.existsSync(path.join(candidate.path, sig.marker))) continue;
      return candidate;
    } catch (_) { /* unreadable: treat as absent */ }
  }
  return null;
}

/**
 * Count files under a directory, stopping early — used only to tell an active
 * installation from a freshly created empty one.
 * @param {string} dir
 * @param {number} [limit=25]
 * @returns {number}
 */
function shallowCount(dir, limit) {
  const cap = limit || 25;
  let count = 0;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length && count < cap) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (count >= cap) break;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else count++;
    }
  }
  return count;
}

/**
 * Build the environment a harness needs to route through the capture proxy.
 *
 * @param {import('./registry').HarnessSignature} sig
 * @param {{host:string, port:number, defaultProvider?:string}} proxy
 * @returns {{env:Record<string,string>, url:string}|null}
 */
function proxyWiring(sig, proxy) {
  if (!sig.byok || !sig.baseUrlEnv || !sig.baseUrlEnv.length) return null;
  const provider = proxy.defaultProvider || 'openrouter';
  const base = 'http://' + proxy.host + ':' + proxy.port + '/' + sig.id + '/' + provider;
  /** @type {Record<string,string>} */
  const env = {};
  for (const key of sig.baseUrlEnv) {
    // Anthropic and Gemini clients append their own version segment; OpenAI
    // clients expect the base to already include /v1.
    env[key] = key === 'ANTHROPIC_BASE_URL' || key === 'GOOGLE_GEMINI_BASE_URL' ? base : base + '/v1';
  }
  return { env, url: base };
}

/**
 * Scan this machine for installed harnesses.
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.homes] per-harness path overrides
 * @param {{host:string, port:number, enabled:boolean, defaultProvider?:string}} [options.proxy]
 * @returns {{scannedAt:string, platform:string, detected:object[], missing:object[]}}
 */
function scan(options) {
  const opts = options || {};
  const homeOverrides = opts.homes || {};
  const proxy = opts.proxy || { host: '127.0.0.1', port: 8898, enabled: false };

  const detected = [];
  const missing = [];

  for (const sig of registry.all()) {
    /** @type {string|null} */
    let bin = null;
    for (const name of sig.bins || []) {
      bin = whichSync(name);
      if (bin) break;
    }
    const home = resolveHome(sig, homeOverrides[sig.id]);

    if (!bin && !home) {
      missing.push({ id: sig.id, label: sig.label });
      continue;
    }

    const wiring = proxy.enabled ? proxyWiring(sig, proxy) : null;
    detected.push({
      id: sig.id,
      label: sig.label,
      installed: true,
      binPath: bin,
      homePath: home ? home.path : null,
      homeSource: home ? home.source : null,
      // A home directory with no files is an install that has never run, so
      // its logs will be empty — worth surfacing rather than reporting silence.
      hasData: home ? shallowCount(home.path) > 0 : false,
      capabilities: {
        quota: sig.quota,
        tokens: sig.tokens,
        byok: !!sig.byok
      },
      captureReady: sig.tokens === 'logs' || sig.quota === 'official' || !!wiring,
      proxyWiring: wiring,
      configHint: sig.configHint || null,
      notes: sig.notes || null
    });
  }

  return {
    scannedAt: new Date().toISOString(),
    platform: process.platform,
    hostname: os.hostname(),
    proxyEnabled: !!proxy.enabled,
    detected,
    missing
  };
}

module.exports = { scan, whichSync, resolveHome, proxyWiring };
