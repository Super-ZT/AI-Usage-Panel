'use strict';
// Subscription Usage Panel — data collector + local server.
// No external deps. Node built-ins only.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharedPricing = require('./src/core/pricing');
const localUsage = require('./src/core/local-usage');

const HOME = os.homedir();
const ROOT = __dirname;
// ---------- harness data directories ----------
// Resolved automatically on any machine: an explicit config override wins, then
// the CLI's own environment variable, then the platform default. A configured
// path that no longer exists is ignored rather than trusted, so a stale entry
// (or a config copied between machines) degrades to auto-detection instead of
// silently reporting no data.
const { resolveHome } = require('./src/detect');
const harnessRegistry = require('./src/detect/registry');

/** @type {Map<string, {path:string|null, at:number}>} */
const homeCache = new Map();

/**
 * @param {string} id registry id, e.g. 'claude-code'
 * @param {string} configKey key under config.paths, e.g. 'claudeHome'
 * @returns {string} the resolved directory, or the platform default if absent
 */
function harnessHome(id, configKey) {
  const cached = homeCache.get(id);
  if (cached && Date.now() - cached.at < 60000) return cached.path;

  const sig = harnessRegistry.byId(id);
  const override = (CONFIG.paths && CONFIG.paths[configKey]) || null;
  const found = sig ? resolveHome(sig, override) : null;
  // Fall back to the first registry default so downstream reads simply find
  // nothing, rather than throwing on an undefined path.
  const fallback = sig && sig.homes && sig.homes[0]
    ? sig.homes[0].replace(/^~/, HOME)
    : path.join(HOME, '.' + id);
  const resolved = found ? found.path : fallback;

  homeCache.set(id, { path: resolved, at: Date.now() });
  return resolved;
}

function claudeHome() { return harnessHome('claude-code', 'claudeHome'); }
function codexHome() { return harnessHome('codex', 'codexHome'); }
function grokHome() { return harnessHome('grok-build', 'grokHome'); }
// ---------- config and state locations ----------
// An installed application cannot assume its own directory is writable, so
// mutable state lives in the per-user data directory. Config is read from the
// user's config directory when present, otherwise from the bundled default
// next to the app — which keeps a portable/checkout install working unchanged.
const appPaths = require('./src/core/paths');
const runtimeConfig = require('./src/core/runtime-config');

const STATE_PATH = (function () {
  const target = path.join(appPaths.dataDir(), 'state.json');
  try {
    if (!fs.existsSync(target)) {
      // One-time migration from the legacy in-directory location.
      const legacy = path.join(ROOT, 'state.json');
      if (fs.existsSync(legacy)) {
        appPaths.ensureDir(appPaths.dataDir());
        fs.copyFileSync(legacy, target);
        fs.renameSync(legacy, legacy + '.migrated');
        console.log('Migrated state.json to ' + target);
      }
    }
  } catch (err) {
    console.log('state migration skipped: ' + (err && err.message));
  }
  return target;
})();
// Changes whenever the server or page code changes (or the server restarts), so
// an open page can detect it's running outdated code and reload itself.
const BUILD_ID = (function () {
  let s = String(Date.now());
  try {
    const a = fs.statSync(path.join(ROOT, 'refresher.js')).mtimeMs;
    const b = fs.statSync(path.join(ROOT, 'dashboard.html')).mtimeMs;
    s = String(Math.round(a)) + '-' + String(Math.round(b));
  } catch (e) { /* fall back to start time */ }
  return s;
})();
const HTML_PATH = path.join(ROOT, 'dashboard.html');

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback; }
}
// ---------- persistent state ----------
// One in-memory copy with a single writer. Several collectors update state in
// the same pass; when each did its own load-modify-save, a later save built on
// an earlier snapshot silently discarded the writes in between — which for
// OpenRouter meant recomputing spend from a stale baseline and adding the same
// dollars to the daily total twice.

/** @type {object|null} */
let STATE = null;

/** @returns {object} the live state object */
function getState() {
  if (!STATE) STATE = loadJSON(STATE_PATH, {});
  return STATE;
}

/**
 * Persist state atomically: a crash mid-write would otherwise leave truncated
 * JSON that silently resets every cached total on the next start.
 * @param {object} [s] optional object to adopt as the current state
 */
function saveState(s) {
  if (s && s !== STATE) STATE = s;
  const snapshot = getState();
  try {
    appPaths.ensureDir(path.dirname(STATE_PATH));
    const tmp = STATE_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { /* read-only install: state is best-effort */ }
}

/**
 * Apply a change to state and persist it. All mutations go through here so
 * concurrent collectors cannot clobber one another's writes.
 * @param {(state: object) => void} fn
 */
function mutateState(fn) {
  const state = getState();
  try { fn(state); } catch (_) { /* a failed mutation must not lose the rest */ }
  saveState(state);
}

let CONFIG = runtimeConfig.load(ROOT);
const PORT = CONFIG.port || 8899;

// Set by startSync() when fleet sync is active. Both proxy-captured and local
// subscription usage call this after recording new facts.
let notifyNewUsage = () => {};

// ---------- helpers ----------
function walk(dir, filterFn, out, maxDepth) {
  out = out || [];
  if (maxDepth === undefined) maxDepth = 8;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (maxDepth > 0) walk(full, filterFn, out, maxDepth - 1);
    } else if (filterFn(full, ent)) {
      out.push(full);
    }
  }
  return out;
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); }
  catch (e) { return []; }
}

// ---------- Claude ----------
// Primary source: the same OAuth usage endpoint that /usage uses, called with
// the token Claude Code keeps in ~/.claude/.credentials.json. Falls back to
// local transcript parsing if the endpoint is unreachable.

let claudeCache = { at: 0, data: null };
let claudeLogCache = { at: 0, data: null };

function pctWindow(percent, resetsAtIso, windowMs) {
  // Derive burn (%/h) and projected finish from utilization vs window elapsed.
  const resetAt = resetsAtIso ? Date.parse(resetsAtIso) : null;
  const now = Date.now();
  let ratePerHour = null, finishAt = null;
  if (resetAt && windowMs && percent != null && percent > 0) {
    const windowStart = resetAt - windowMs;
    const elapsedH = Math.max((now - windowStart) / 3600000, 1 / 60);
    ratePerHour = percent / elapsedH;
    if (percent < 100 && ratePerHour > 0) {
      finishAt = Math.min(now + ((100 - percent) / ratePerHour) * 3600000, resetAt);
    }
  }
  return { percent, resetAt, ratePerHour, finishAt };
}

async function collectClaudeOAuth() {
  const creds = loadJSON(path.join(claudeHome(), '.credentials.json'), {});
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) return { status: 'no-token' };
  const r = await httpsGetJSON('https://api.anthropic.com/api/oauth/usage', {
    Authorization: 'Bearer ' + oauth.accessToken,
    'anthropic-beta': 'oauth-2025-04-20'
  });
  if (r.status === 401 || r.status === 403) return { status: 'token-expired' };
  if (r.status !== 200 || !r.json) return { status: 'error', message: 'HTTP ' + r.status };
  const j = r.json;
  const limits = Array.isArray(j.limits) ? j.limits : [];
  const find = (kind) => limits.find((l) => l.kind === kind);
  const session = find('session');
  const weekly = find('weekly_all');
  const scoped = limits.filter((l) => l.kind === 'weekly_scoped' && l.scope && l.scope.model);

  const H5 = 5 * 3600 * 1000, D7 = 7 * 24 * 3600 * 1000;
  return {
    status: 'ok',
    kind: 'claude',
    label: 'Claude',
    plan: (oauth.subscriptionType || 'subscription'),
    session: session ? pctWindow(session.percent, session.resets_at, H5) : null,
    weekly: weekly ? pctWindow(weekly.percent, weekly.resets_at, D7) : null,
    scoped: scoped.map((l) => ({
      name: (l.scope.model.display_name || 'model').toLowerCase(),
      ...pctWindow(l.percent, l.resets_at, D7)
    })),
    extraUsageEnabled: !!(j.extra_usage && j.extra_usage.is_enabled)
  };
}

// Backoff + last-good handling so we never hammer the endpoint with a dead
// token (Claude Code rotates it ~hourly) and never drop good data from view.
let claudeBackoffUntil = 0;

let claudeLastGood = null; // { data, fetchedAt }

function claudeStale() {
  if (!claudeLastGood) return null;
  const d = Object.assign({}, claudeLastGood.data);
  d.stale = true;
  d.fetchedAt = claudeLastGood.fetchedAt;
  return d;
}

async function collectClaude(forceRefresh) {
  const cfg = (CONFIG.claude || {});
  if (cfg.enabled === false) return { status: 'disabled' };
  const now = Date.now();
  const cacheSec = CONFIG.claudeCacheSeconds || 60;
  if (claudeCache.data && now - claudeCache.at < cacheSec * 1000) return claudeCache.data;

  // restore last good snapshot across restarts
  if (!claudeLastGood) {
    const st = getState();
    if (st.claudeLastGood) claudeLastGood = st.claudeLastGood;
  }

  // don't call with a token we already know is expired — wait for Claude Code
  // to rotate the credentials file, checking again shortly
  const creds = loadJSON(path.join(claudeHome(), '.credentials.json'), {});
  const oauth = creds.claudeAiOauth;
  const tokenValid = oauth && oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > now + 30000);
  let data = null;
  if (tokenValid && now >= claudeBackoffUntil) {
    try { data = await collectClaudeOAuth(); }
    catch (e) { data = { status: 'error', message: String(e.message || e) }; }
    if (data.status === 'ok') {
      claudeBackoffUntil = 0;
      claudeLastGood = { data: data, fetchedAt: now };
      const st = getState();
      st.claudeLastGood = claudeLastGood;
      saveState(st);
    } else if (data.message && data.message.indexOf('429') !== -1) {
      claudeBackoffUntil = now + 15 * 60 * 1000; // rate limited: back way off
    } else if (data.status === 'token-expired') {
      claudeBackoffUntil = now + 2 * 60 * 1000;  // wait for token rotation
    } else {
      claudeBackoffUntil = now + 5 * 60 * 1000;
    }
  }

  if (!data || data.status !== 'ok') {
    // prefer showing slightly-old official data over degrading the card
    const stale = claudeStale();
    if (stale) data = stale;
    else {
      const logs = collectClaudeLogs();
      if (logs.status === 'ok') {
        logs.note = tokenValid ? 'oauth unavailable — local log estimate' : 'waiting for claude code to refresh token — local log estimate';
        data = logs;
      } else data = data || { status: 'no-token' };
    }
  }

  if (data.status === 'ok' && data.kind === 'claude') {
    const logs = collectClaudeLogs();
    if (logs.status === 'ok') { data.burnTokensPerHour = logs.burnPerHour; data.weekTokens = logs.weekTokens; }
  }
  claudeCache = { at: now, data };
  return data;
}

// ---------- Claude fallback (local Claude Code transcripts) ----------
function collectClaudeLogs() {
  if (claudeLogCache.data && Date.now() - claudeLogCache.at < 120000) return claudeLogCache.data;
  const cfg = (CONFIG.claude || {});
  const projects = path.join(claudeHome(), 'projects');
  const windowHours = cfg.windowHours || 5;
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const budget = Number(cfg.tokenBudget) || 0;

  // Only scan files touched in the last 8 days for speed.
  const files = walk(projects, (full, ent) => {
    if (!full.endsWith('.jsonl')) return false;
    try { return fs.statSync(full).mtimeMs >= weekAgo - 24 * 3600 * 1000; }
    catch (e) { return false; }
  });

  const events = []; // {t, tokens}
  for (const f of files) {
    for (const line of readLines(f)) {
      if (line.indexOf('"output_tokens"') === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
      const u = o.message.usage;
      const t = Date.parse(o.timestamp);
      if (!t) continue;
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      events.push({ t, tokens });
    }
  }
  events.sort((a, b) => a.t - b.t);
  if (!events.length) return { status: 'no-data' };

  // Build the active rolling block (ccusage-style): a block starts at first
  // activity floored to the hour and spans windowHours; a gap >= windowHours
  // starts a new block. The active block is the last one still open.
  const winMs = windowHours * 3600 * 1000;
  let blockStart = null, lastT = null, blockTokens = 0;
  for (const ev of events) {
    if (blockStart === null) {
      blockStart = Math.floor(ev.t / 3600000) * 3600000;
      blockTokens = 0;
    } else if (ev.t - lastT >= winMs || ev.t - blockStart >= winMs) {
      blockStart = Math.floor(ev.t / 3600000) * 3600000;
      blockTokens = 0;
    }
    blockTokens += ev.tokens;
    lastT = ev.t;
  }
  const blockEnd = blockStart + winMs;
  const active = now < blockEnd;
  const windowTokens = active ? blockTokens : 0;
  const elapsedH = active ? Math.max((now - blockStart) / 3600000, 1 / 60) : 0;
  const burnPerHour = active ? windowTokens / elapsedH : 0;

  // Weekly total
  let weekTokens = 0;
  for (const ev of events) if (ev.t >= weekAgo) weekTokens += ev.tokens;

  let pct = null, finishAt = null;
  if (budget > 0) {
    pct = Math.min(100, (windowTokens / budget) * 100);
    if (active && burnPerHour > 0 && windowTokens < budget) {
      const hoursLeft = (budget - windowTokens) / burnPerHour;
      finishAt = Math.min(now + hoursLeft * 3600000, blockEnd);
    }
  }

  const data = {
    status: 'ok',
    kind: 'window',
    label: 'Claude (logs)',
    plan: 'subscription',
    windowHours,
    windowTokens,
    weekTokens,
    budget,
    pct,
    burnPerHour,
    resetAt: active ? blockEnd : null,
    finishAt,
    active
  };
  claudeLogCache = { at: Date.now(), data };
  return data;
}

// ---------- Codex (local OpenAI Codex CLI logs) ----------
// Official account-wide usage from the ChatGPT backend (same numbers as the
// Codex usage page) using the CLI's own token — authoritative even when the
// heavy usage happened on other surfaces (cloud tasks, IDE, other machines).
let codexOffCache = { at: 0, data: null };
let codexOffBackoffUntil = 0;
async function collectCodexOfficial() {
  const now = Date.now();
  if (codexOffCache.data && now - codexOffCache.at < 60000) return codexOffCache.data;
  if (now < codexOffBackoffUntil) return null;
  const auth = loadJSON(path.join(codexHome(), 'auth.json'), null);
  const tok = auth && auth.tokens && auth.tokens.access_token;
  if (!tok) return null;
  let r;
  try {
    r = await httpsGetJSON('https://chatgpt.com/backend-api/wham/usage', {
      Authorization: 'Bearer ' + tok,
      'chatgpt-account-id': auth.tokens.account_id || '',
      'User-Agent': 'codex-cli'
    });
  } catch (e) { r = { status: 0 }; }
  if (r.status !== 200 || !r.json || !r.json.rate_limit) {
    codexOffBackoffUntil = now + (r.status === 429 ? 15 : 5) * 60 * 1000;
    return null;
  }
  const j = r.json;
  function mapWin(w) {
    if (!w) return null;
    const resetAt = w.reset_at ? w.reset_at * 1000 : null;
    const windowMin = w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : 0;
    const used = typeof w.used_percent === 'number' ? w.used_percent : null;
    let finishAt = null, ratePerHour = null;
    if (resetAt && windowMin && used != null && used > 0) {
      const windowStart = resetAt - windowMin * 60000;
      const elapsedH = Math.max((now - windowStart) / 3600000, 1 / 60);
      ratePerHour = used / elapsedH;
      if (used < 100 && ratePerHour > 0) finishAt = Math.min(now + ((100 - used) / ratePerHour) * 3600000, resetAt);
    }
    return { usedPercent: used, windowMinutes: windowMin, resetAt, finishAt, ratePerHour };
  }
  const data = {
    status: 'ok',
    kind: 'window',
    source: 'official',
    label: 'Codex' + (j.plan_type ? ' (' + j.plan_type + ')' : ''),
    plan: 'subscription',
    primary: mapWin(j.rate_limit.primary_window),
    secondary: mapWin(j.rate_limit.secondary_window),
    scoped: (j.additional_rate_limits || []).filter((l) => l.rate_limit && l.rate_limit.primary_window).map((l) => Object.assign(
      { name: (l.limit_name || 'scoped').toLowerCase() }, mapWin(l.rate_limit.primary_window))),
    creditsBalance: j.credits && j.credits.balance != null ? j.credits.balance : null,
    hasCredits: !!(j.credits && j.credits.has_credits)
  };
  codexOffCache = { at: now, data };
  return data;
}

async function collectCodex() {
  const cfg = (CONFIG.codex || {});
  if (cfg.enabled === false) return { status: 'disabled' };
  const official = await collectCodexOfficial();
  if (official) {
    const logs = collectCodexLogs();
    if (logs && logs.status === 'ok') { official.burnPerHour = logs.burnPerHour; official.totalTokens = logs.totalTokens; }
    return official;
  }
  const logs = collectCodexLogs();
  if (logs && logs.status === 'ok') logs.note = 'official endpoint unavailable — local session data';
  return logs;
}

let codexLogCache = { at: 0, data: null };
function collectCodexLogs() {
  // Cached: this walks the whole sessions tree synchronously, and /api/data is
  // polled every 10 seconds.
  if (codexLogCache.data && Date.now() - codexLogCache.at < 60000) return codexLogCache.data;
  const result = collectCodexLogsUncached();
  codexLogCache = { at: Date.now(), data: result };
  return result;
}

function collectCodexLogsUncached() {
  const sessions = path.join(codexHome(), 'sessions');
  const files = walk(sessions, (full) => full.endsWith('.jsonl'))
    .map((f) => { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch (e) {} return { f, m }; })
    .sort((a, b) => b.m - a.m)
    .slice(0, 6);

  let rl = null, planType = null, totalTokens = null;
  let firstTok = null, lastTok = null; // {t, total}
  for (const { f } of files) {
    const lines = readLines(f);
    let foundHere = false;
    for (const line of lines) {
      if (line.indexOf('token_count') === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      const payload = o && o.payload;
      if (!payload) continue;
      const info = payload.info;
      const t = Date.parse(o.timestamp) || null;
      if (info && info.total_token_usage && t) {
        const tot = info.total_token_usage.total_tokens || 0;
        if (!firstTok) firstTok = { t, total: tot };
        lastTok = { t, total: tot };
      }
      if (payload.rate_limits && payload.rate_limits.primary) {
        rl = payload.rate_limits;
        planType = rl.plan_type || planType;
        if (info && info.total_token_usage) totalTokens = info.total_token_usage.total_tokens;
        foundHere = true;
      }
    }
    if (foundHere && rl) break; // newest file with rate-limit data wins
  }
  if (!rl) return { status: 'no-data' };

  const now = Date.now();
  function windowInfo(w) {
    if (!w) return null;
    const resetAt = w.resets_at ? w.resets_at * 1000 : null;
    const windowMin = w.window_minutes || 0;
    const used = typeof w.used_percent === 'number' ? w.used_percent : null;
    let finishAt = null, ratePerHour = null;
    if (resetAt && windowMin && used != null && used > 0) {
      const windowStart = resetAt - windowMin * 60000;
      const elapsedH = Math.max((now - windowStart) / 3600000, 1 / 60);
      ratePerHour = used / elapsedH; // percent per hour
      if (used < 100 && ratePerHour > 0) {
        finishAt = Math.min(now + ((100 - used) / ratePerHour) * 3600000, resetAt);
      }
    }
    return { usedPercent: used, windowMinutes: windowMin, resetAt, finishAt, ratePerHour };
  }

  // burn in tokens/hr from token_count deltas within the newest session
  let burnPerHour = 0;
  if (firstTok && lastTok && lastTok.t > firstTok.t) {
    burnPerHour = (lastTok.total - firstTok.total) / ((lastTok.t - firstTok.t) / 3600000);
  }

  const credits = rl.credits || {};
  return {
    status: 'ok',
    kind: 'window',
    label: 'Codex' + (planType ? ' (' + planType + ')' : ''),
    plan: 'subscription',
    primary: windowInfo(rl.primary),
    secondary: windowInfo(rl.secondary),
    totalTokens,
    burnPerHour,
    creditsBalance: credits.balance != null ? credits.balance : null,
    hasCredits: !!credits.has_credits
  };
}

// ---------- OpenRouter (API) ----------
/** Guard against an endpoint (or captive portal) streaming an unbounded body. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function httpsGetJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 12000 }, (res) => {
      let body = '';
      res.on('data', (c) => {
        if (body.length > MAX_RESPONSE_BYTES) { req.destroy(new Error('response too large')); return; }
        body += c;
      });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

let orCache = { at: 0, data: null };
async function collectOpenRouter(state) {
  const cfg = (CONFIG.openrouter || {});
  if (cfg.enabled === false) return { status: 'disabled' };
  const cacheSec = CONFIG.openrouterCacheSeconds || 120;
  if (orCache.data && Date.now() - orCache.at < cacheSec * 1000) return orCache.data;

  // Read key from opencode auth store (server-side only).
  let key = cfg.apiKey || null;
  if (!key) {
    const auth = loadJSON(path.join(HOME, '.local', 'share', 'opencode', 'auth.json'), {});
    if (auth.openrouter && auth.openrouter.key) key = auth.openrouter.key;
  }
  if (!key) return { status: 'no-key' };

  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  try {
    const [credits, keyInfo] = await Promise.all([
      httpsGetJSON('https://openrouter.ai/api/v1/credits', headers),
      httpsGetJSON('https://openrouter.ai/api/v1/key', headers)
    ]);
    const cd = (credits.json && credits.json.data) || {};
    const kd = (keyInfo.json && keyInfo.json.data) || {};
    const totalCredits = cd.total_credits != null ? cd.total_credits : null;
    const totalUsage = cd.total_usage != null ? cd.total_usage : (kd.usage != null ? kd.usage : null);
    const limit = kd.limit != null ? kd.limit : null;
    const remaining = kd.limit_remaining != null ? kd.limit_remaining
      : (totalCredits != null && totalUsage != null ? totalCredits - totalUsage : null);

    // spend rate from persisted prior usage
    let spendPerHour = null;
    const now = Date.now();
    if (state.openrouter && state.openrouter.usage != null && totalUsage != null) {
      const dh = (now - state.openrouter.at) / 3600000;
      if (dh > 0.02) spendPerHour = Math.max(0, (totalUsage - state.openrouter.usage) / dh);
      // accumulate true daily spend from API usage deltas
      const delta = totalUsage - state.openrouter.usage;
      if (delta > 0) {
        const dk = dayKey(now);
        state.orDaily = state.orDaily || {};
        state.orDaily[dk] = (state.orDaily[dk] || 0) + delta;
      }
    }
    state.openrouter = { usage: totalUsage, at: now };
    saveState(state);

    let finishAt = null;
    if (spendPerHour && spendPerHour > 0 && remaining != null && remaining > 0) {
      finishAt = now + (remaining / spendPerHour) * 3600000;
    }

    const data = {
      status: 'ok',
      kind: 'balance',
      label: 'OpenRouter',
      plan: 'api',
      totalCredits, totalUsage, limit, remaining,
      isFreeTier: kd.is_free_tier || false,
      spendPerHour, finishAt
    };
    orCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (orCache.data) return orCache.data;
    return { status: 'error', message: String(e.message || e) };
  }
}

// ---------- Grok (Grok Build CLI proxy probe) ----------
// The proxy returns x-ratelimit-* headers only on real completions, so we
// sample with a minimal 1-token low-reasoning probe every probeMinutes.
let grokCache = { at: 0, data: null };
let grokLastGood = null;
let grokBackoffUntil = 0;

function grokAuthEntry() {
  const auth = loadJSON(path.join(grokHome(), 'auth.json'), null);
  if (!auth) return null;
  for (const v of Object.values(auth)) if (v && v.key) return v;
  return null;
}

function grokVersion() {
  const v = loadJSON(path.join(grokHome(), 'version.json'), {});
  return v.version || '0.2.103';
}


// True local consumption from Grok Build session logs: each updates.jsonl line
// carries _meta.totalTokens (cumulative per session) + a unix timestamp.
let grokLogCache = { at: 0, data: null };
function grokLogs() {
  const now = Date.now();
  if (grokLogCache.data && now - grokLogCache.at < 120000) return grokLogCache.data;
  const root = path.join(grokHome(), 'sessions');
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const files = walk(root, (full) => {
    if (!full.endsWith('updates.jsonl')) return false;
    try { return fs.statSync(full).mtimeMs >= weekAgo - 24 * 3600 * 1000; }
    catch (e) { return false; }
  });
  const events = []; // token deltas attributed at event time
  for (const f of files) {
    let prev = 0;
    for (const line of readLines(f)) {
      const m = line.match(/"totalTokens":(\d+)/);
      if (!m) continue;
      const tm = line.match(/"timestamp":(\d+)/);
      const t = tm ? Number(tm[1]) * 1000 : null;
      if (!t) continue;
      const tot = Number(m[1]);
      const delta = tot - prev;
      if (delta > 0) events.push({ t, tokens: delta });
      if (tot > prev) prev = tot;
    }
  }
  events.sort((a, b) => a.t - b.t);
  const fiveH = now - 5 * 3600 * 1000;
  let windowTokens = 0, weekTokens = 0, windowFirst = null;
  for (const ev of events) {
    if (ev.t >= weekAgo) weekTokens += ev.tokens;
    if (ev.t >= fiveH) { windowTokens += ev.tokens; if (windowFirst === null) windowFirst = ev.t; }
  }
  let burnPerHour = null;
  if (windowFirst !== null && windowTokens > 0) {
    const h = Math.max((now - windowFirst) / 3600000, 1 / 60);
    burnPerHour = windowTokens / h;
  }
  const data = { windowTokens, weekTokens, burnPerHour };
  grokLogCache = { at: now, data };
  return data;
}

function grokStale() {
  if (!grokLastGood) return null;
  const d = Object.assign({}, grokLastGood.data);
  d.stale = true;
  return d;
}

// SuperGrok plan quota — the REAL billing numbers (weekly credit % + monthly
// credits used/limit), same source the Grok CLI itself shows. A plain GET, no
// quota cost, unlike the completion probe. This drives the ring.
function grokGet(pathUrl, key, version) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const r = https.request({
      hostname: 'cli-chat-proxy.grok.com', path: pathUrl, method: 'GET',
      headers: {
        Authorization: 'Bearer ' + key,
        'User-Agent': 'grok-cli/' + version,
        'x-grok-client-version': version,
        'x-grok-client-identifier': 'grok-cli',
        'x-grok-client-surface': 'grok-build'
      }, timeout: 15000
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        // Cap the body: a captive portal or misbehaving endpoint could
        // otherwise stream unbounded HTML into memory on every poll.
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish({ error: 'response too large' });
          res.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (e) => finish({ error: String(e.message || e) }));
      res.on('aborted', () => finish({ error: 'response aborted' }));
      res.on('end', () => {
        const b = Buffer.concat(chunks).toString('utf8');
        try { finish({ status: res.statusCode, json: JSON.parse(b) }); }
        catch (e) { finish({ status: res.statusCode, json: null }); }
      });
    });
    r.on('error', (e) => finish({ error: String(e.message || e) }));
    r.on('timeout', () => { r.destroy(); finish({ error: 'timeout' }); });
    r.on('close', () => finish({ error: 'request closed before completion' }));
    r.end();
  });
}

async function grokBilling(key, version) {
  const [credits, monthly] = await Promise.all([
    grokGet('/v1/billing?format=credits', key, version),
    grokGet('/v1/billing', key, version)
  ]);
  const out = {};
  // A local expiry timestamp can be stale or simply wrong — a token revoked or
  // rotated elsewhere still looks valid on disk. Surface the transport status
  // so the caller can tell "rejected" apart from "unreachable".
  out.unauthorized = credits.status === 401 || credits.status === 403
    || monthly.status === 401 || monthly.status === 403;
  const cc = credits.json && credits.json.config;
  if (cc) {
    out.weeklyUsedPct = typeof cc.creditUsagePercent === 'number' ? cc.creditUsagePercent : null;
    out.weekStart = cc.currentPeriod && cc.currentPeriod.start ? Date.parse(cc.currentPeriod.start) : (cc.billingPeriodStart ? Date.parse(cc.billingPeriodStart) : null);
    out.weekEnd = cc.currentPeriod && cc.currentPeriod.end ? Date.parse(cc.currentPeriod.end) : (cc.billingPeriodEnd ? Date.parse(cc.billingPeriodEnd) : null);
  }
  const mc = monthly.json && monthly.json.config;
  if (mc) {
    out.monthlyUsed = mc.used ? mc.used.val : null;
    out.monthlyLimit = mc.monthlyLimit ? mc.monthlyLimit.val : null;
    out.monthEnd = mc.billingPeriodEnd ? Date.parse(mc.billingPeriodEnd) : null;
  }
  out.ok = out.weeklyUsedPct != null || out.monthlyUsed != null;
  return out;
}

async function collectGrok(state, forceRefresh) {
  const cfg = (CONFIG.grok || {});
  if (cfg.enabled === false) return pending('Grok');
  const now = Date.now();
  const cacheMs = (cfg.cacheSeconds || 60) * 1000; // billing is a cheap GET
  if (grokCache.data && now - grokCache.at < cacheMs) {
    grokCache.data.usage = grokLogs(); // local logs are always fresh
    return grokCache.data;
  }

  if (!grokLastGood) {
    const st0 = getState();
    if (st0.grokLastGood) grokLastGood = st0.grokLastGood;
  }

  const entry = grokAuthEntry();
  if (!entry) return pending('Grok');
  const tokenValid = !entry.expires_at || Date.parse(entry.expires_at) > now + 30000;
  if (!tokenValid) {
    const s = grokStale();
    if (s) { s.usage = grokLogs(); return s; }
    return { status: 'no-data', label: 'Grok', plan: 'subscription' };
  }

  // PRIMARY: real SuperGrok plan quota (cheap GET, no quota cost).
  const bill = await grokBilling(entry.key, grokVersion());
  if (!bill.ok) {
    grokBackoffUntil = now + 5 * 60 * 1000;
    const s = grokStale();
    if (s) {
      s.usage = grokLogs();
      s.authFailed = !!bill.unauthorized;
      return s;
    }
    return {
      status: 'error', label: 'Grok', plan: 'subscription',
      message: bill.unauthorized ? 'token rejected — sign in to Grok again' : 'billing unavailable'
    };
  }

  const data = {
    status: 'ok', kind: 'grok', label: 'Grok', plan: 'SuperGrok',
    weekly: bill.weeklyUsedPct != null ? {
      usedPct: bill.weeklyUsedPct,
      remainingPct: Math.max(0, 100 - bill.weeklyUsedPct),
      resetAt: bill.weekEnd
    } : null,
    monthly: (bill.monthlyUsed != null && bill.monthlyLimit) ? {
      used: bill.monthlyUsed,
      limit: bill.monthlyLimit,
      usedPct: (bill.monthlyUsed / bill.monthlyLimit) * 100,
      resetAt: bill.monthEnd
    } : null,
    usage: grokLogs(), // local session-token observation (not plan quota)
    sampledAt: now
  };
  grokLastGood = { data, fetchedAt: now };
  const st = getState();
  st.grokLastGood = grokLastGood;
  saveState(st);
  grokCache = { at: now, data };
  return data;
}

// ---------- versioned OpenRouter-equivalent pricing ----------
async function fetchOrPricing() {
  const catalogue = sharedPricing.catalogue();
  return {
    at: Date.now(),
    map: catalogue.map,
    version: catalogue.version,
    fetchedAt: Date.parse(catalogue.asOf),
    asOf: catalogue.asOf
  };
}

function priceFor(map, localModel) {
  const ov = (CONFIG.pricing && CONFIG.pricing.overrides) || {};
  const found = sharedPricing.resolve(localModel, ov);
  return found ? found.price : null;
}

// ---------- token usage by day (true counts from API-recorded usage) ----------
function dayKey(ts) {
  const d = new Date(ts); // server runs in local (SGT) time — buckets are local days
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Claude: every assistant line in ~/.claude/projects transcripts carries the
// API's own usage object. Dedupe by message id + requestId (forked sessions
// duplicate lines). Per-file cache keyed on mtime keeps rescans cheap.
let claudeTokFileCache = {}; // file -> { mtime, entries: [key,t,in,out,cacheCreate,cacheRead] }

/**
 * How far back raw transcripts are parsed. Older days are served from the
 * persisted tokenHistory instead, so a multi-gigabyte transcript archive is
 * never re-read on every request.
 */
function scanWindowDays() {
  const n = Number(CONFIG.scanWindowDays);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

/** Files above this size are skipped: reading one fully would stall the loop. */
const MAX_LOG_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Files skipped this run because they exceed MAX_LOG_FILE_BYTES.
 *
 * Reported through /api/tokens and shown in the UI: a total that quietly omits
 * a log file is worse than no total at all, since the user has no way to tell
 * the number is short. Cleared at the start of every aggregation so a
 * since-deleted file does not linger in the warning forever.
 *
 * @type {Set<string>}
 */
const skippedLogFiles = new Set();

function claudeTokenEntries() {
  const projects = path.join(claudeHome(), 'projects');
  const cutoff = Date.now() - scanWindowDays() * 24 * 3600 * 1000;
  const files = walk(projects, (f) => {
    if (!f.endsWith('.jsonl')) return false;
    try { return fs.statSync(f).mtimeMs >= cutoff; } catch (_) { return false; }
  });
  const all = [];
  const live = new Set();
  for (const f of files) {
    live.add(f);
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.size > MAX_LOG_FILE_BYTES) { skippedLogFiles.add(f); continue; }
    const c = claudeTokFileCache[f];
    if (!c || c.mtime !== st.mtimeMs) {
      const entries = [];
      for (const line of readLines(f)) {
        if (line.indexOf('"usage"') === -1 || line.indexOf('"assistant"') === -1) continue;
        const tm = line.match(/"timestamp":"([^"]+)"/); if (!tm) continue;
        const t = Date.parse(tm[1]); if (!t) continue;
        const num = (re) => Number((line.match(re) || [])[1] || 0);
        const inp = num(/"input_tokens":(\d+)/), out = num(/"output_tokens":(\d+)/);
        const cc = num(/"cache_creation_input_tokens":(\d+)/), cr = num(/"cache_read_input_tokens":(\d+)/);
        // Prefer nested cache_creation TTL split when present (1h vs 5m rates).
        const cc5m = num(/"ephemeral_5m_input_tokens":(\d+)/);
        const cc1h = num(/"ephemeral_1h_input_tokens":(\d+)/);
        const cacheWrite = cc || (cc5m + cc1h);
        if (!inp && !out && !cacheWrite && !cr) continue;
        const idm = line.match(/"id":"(msg_[a-zA-Z0-9]+)"/);
        const rqm = line.match(/"requestId":"([^"]+)"/);
        const uim = line.match(/"uuid":"([^"]+)"/);
        const mdm = line.match(/"model":"([^"]+)"/);
        const messageId = idm ? idm[1] : '';
        const requestId = rqm ? rqm[1] : '';
        const identity = messageId || requestId
          ? messageId + '|' + requestId
          : 'fallback|' + (uim ? uim[1] : String(t));
        entries.push([identity, t, inp, out, cacheWrite, cr, mdm ? mdm[1] : 'unknown', cc5m, cc1h]);
      }
      claudeTokFileCache[f] = { mtime: st.mtimeMs, entries };
    }
    all.push(...claudeTokFileCache[f].entries);
  }
  for (const k of Object.keys(claudeTokFileCache)) if (!live.has(k)) delete claudeTokFileCache[k];
  return all;
}

// Codex: rollout lines carry cumulative total_token_usage — attribute deltas.
let codexTokFileCache = {}; // file -> { mtime, days }
function codexDailyTokens(days, ensure) {
  const roots = [path.join(codexHome(), 'sessions'), path.join(codexHome(), 'archived_sessions')];
  const cutoff = Date.now() - scanWindowDays() * 24 * 3600 * 1000;
  const files = [];
  for (const r of roots) {
    walk(r, (f) => {
      if (!/rollout-.*\.jsonl$/.test(f)) return false;
      try {
        const st = fs.statSync(f);
        if (st.size > MAX_LOG_FILE_BYTES) { skippedLogFiles.add(f); return false; }
        return st.mtimeMs >= cutoff;
      } catch (_) { return false; }
    }).forEach((f) => files.push(f));
  }
  const live = new Set();
  for (const f of files) {
    live.add(f);
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    const c = codexTokFileCache[f];
    if (!c || c.mtime !== st.mtimeMs) {
      const fdays = {}; // day -> model -> {in,out,cached}
      let pIn = 0, pOut = 0, pCached = 0, curModel = 'unknown';
      for (const line of readLines(f)) {
        const mdm = line.match(/"model":"([^"]+)"/);
        if (mdm) curModel = mdm[1];
        if (line.indexOf('total_token_usage') === -1) continue;
        const tm = line.match(/"timestamp":"([^"]+)"/); if (!tm) continue;
        const t = Date.parse(tm[1]); if (!t) continue;
        const seg = (line.match(/"total_token_usage":\{([^{}]*)\}/) || [])[1]; if (!seg) continue;
        const num = (re) => Number((seg.match(re) || [])[1] || 0);
        const cin = num(/"input_tokens":(\d+)/), cout = num(/"output_tokens":(\d+)/), cch = num(/"cached_input_tokens":(\d+)/);
        const reset = cin < pIn || cout < pOut || cch < pCached;
        const baseIn = reset ? 0 : pIn;
        const baseOut = reset ? 0 : pOut;
        const baseCached = reset ? 0 : pCached;
        const dIn = Math.max(0, cin - baseIn);
        const dOut = Math.max(0, cout - baseOut);
        const dCch = Math.min(dIn, Math.max(0, cch - baseCached));
        if (dIn > 0 || dOut > 0) {
          const k = dayKey(t);
          const dm = fdays[k] || (fdays[k] = {});
          const b = dm[curModel] || (dm[curModel] = { in: 0, out: 0, cached: 0 });
          const split = localUsage.splitCodexInput(dIn, dCch);
          if (split.in > 0) b.in += split.in;
          if (dOut > 0) b.out += dOut;
          if (split.cache_read > 0) b.cached += split.cache_read;
        }
        pIn = cin; pOut = cout; pCached = cch;
      }
      codexTokFileCache[f] = { mtime: st.mtimeMs, days: fdays };
    }
    for (const [k, dm] of Object.entries(codexTokFileCache[f].days)) {
      const d = ensure(days, k);
      for (const [m, v] of Object.entries(dm)) {
        d.codex.in += v.in; d.codex.out += v.out; d.codex.cached += v.cached;
        const mm = d.codexModels[m] || (d.codexModels[m] = { in: 0, out: 0, cached: 0 });
        mm.in += v.in; mm.out += v.out; mm.cached += v.cached;
      }
    }
  }
  for (const k of Object.keys(codexTokFileCache)) if (!live.has(k)) delete codexTokFileCache[k];
}

// Grok: cumulative totalTokens per session — attribute deltas (no in/out split).
let grokTokFileCache = {};
function grokDailyTokens(days, ensure) {
  const root = path.join(grokHome(), 'sessions');
  const files = walk(root, (f) => f.endsWith('updates.jsonl'));
  const live = new Set();
  for (const f of files) {
    live.add(f);
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    const c = grokTokFileCache[f];
    if (!c || c.mtime !== st.mtimeMs) {
      const fdays = {};
      let prev = 0;
      for (const line of readLines(f)) {
        const m = line.match(/"totalTokens":(\d+)/); if (!m) continue;
        const tm = line.match(/"timestamp":(\d+)/); if (!tm) continue;
        const t = Number(tm[1]) * 1000;
        const tot = Number(m[1]);
        if (tot > prev) {
          const k = dayKey(t);
          fdays[k] = (fdays[k] || 0) + (tot - prev);
          prev = tot;
        }
      }
      // Only the summary's current_model_id is a fact; inventing "grok-4.5"
      // would present a hardcoded default as a detected model.
      let model = 'unknown';
      const summary = loadJSON(path.join(path.dirname(f), 'summary.json'), null);
      if (summary && typeof summary.current_model_id === 'string' && summary.current_model_id.trim()) {
        model = summary.current_model_id.trim();
      }
      grokTokFileCache[f] = { mtime: st.mtimeMs, days: fdays, model };
    }
    const gModel = grokTokFileCache[f].model || 'unknown';
    for (const [k, v] of Object.entries(grokTokFileCache[f].days)) {
      const d = ensure(days, k);
      d.grok.total += v;
      d.grokModels[gModel] = (d.grokModels[gModel] || 0) + v;
    }
  }
  for (const k of Object.keys(grokTokFileCache)) if (!live.has(k)) delete grokTokFileCache[k];
}

let tokAggCache = { at: 0, data: null };
let localBridgePromise = null;
let localBridgeLastAt = 0;
let localBridgeLastResult = { written: 0, duplicates: 0, files: 0, skipped: 0 };

/**
 * Record new local subscription facts before deriving either local or fleet
 * totals. A single in-flight pass is shared by HTTP polling and sync timers.
 * @returns {Promise<object>}
 */
function bridgeLocalUsage() {
  if (localBridgePromise) return localBridgePromise;
  if (Date.now() - localBridgeLastAt < 2000) return Promise.resolve(localBridgeLastResult);
  const eventStore = require('./src/core/events');
  const { identity } = require('./src/core/device');
  localBridgePromise = localUsage.bridge({
    claudeHome: claudeHome(),
    codexHome: codexHome(),
    grokHome: grokHome(),
    device: identity((CONFIG.sync && CONFIG.sync.deviceLabel) || (CONFIG.proxy && CONFIG.proxy.deviceLabel)),
    lookbackDays: (CONFIG.sync && CONFIG.sync.lookbackDays) || scanWindowDays(),
    eventStore
  }).then((result) => {
    if (result.written) {
      tokAggCache.at = 0;
      harnessCache.at = 0;
      notifyNewUsage();
    }
    localBridgeLastAt = Date.now();
    localBridgeLastResult = result;
    return result;
  }).catch((err) => {
    console.log('[local-usage] bridge failed: ' + (err && err.message || err));
    localBridgeLastAt = Date.now();
    localBridgeLastResult = {
      written: 0, duplicates: 0, files: 0, skipped: 1, error: String(err && err.message || err)
    };
    return localBridgeLastResult;
  }).finally(() => { localBridgePromise = null; });
  return localBridgePromise;
}

async function aggregateTokens() {
  const now = Date.now();
  await bridgeLocalUsage();
  if (tokAggCache.data && now - tokAggCache.at < 120000) return tokAggCache.data;
  const ensure = (days, k) => days[k] || (days[k] = {
    claude: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, est: 0, estFlat: 0 },
    codex: { in: 0, out: 0, cached: 0, est: 0, estFlat: 0 },
    grok: { total: 0, est: 0 },
    openrouter: { spend: 0 },
    claudeModels: {}, codexModels: {}, grokModels: {}
  });
  skippedLogFiles.clear(); // recomputed from scratch on every aggregation
  const days = {};
  // claude with global dedupe
  const seen = new Map();
  for (const e of claudeTokenEntries()) {
    const previous = seen.get(e[0]);
    if (!previous) {
      seen.set(e[0], e.slice());
      continue;
    }
    // Duplicate Claude rows may contain progressively larger usage. Keep the
    // component-wise maximum for the reply, matching the upload top-up ledger.
    previous[1] = Math.min(previous[1], e[1]);
    const highest = localUsage.mergeClaudeTokens(
      {
        in: previous[2], out: previous[3], cache_write: previous[4], cache_read: previous[5],
        cache_write_5m: previous[7] || 0, cache_write_1h: previous[8] || 0
      },
      {
        in: e[2], out: e[3], cache_write: e[4], cache_read: e[5],
        cache_write_5m: e[7] || 0, cache_write_1h: e[8] || 0
      }
    );
    previous[2] = highest.in;
    previous[3] = highest.out;
    previous[4] = highest.cache_write;
    previous[5] = highest.cache_read;
    if (previous[6] === 'unknown' && e[6] !== 'unknown') previous[6] = e[6];
    previous[7] = highest.cache_write_5m;
    previous[8] = highest.cache_write_1h;
  }
  for (const [, t, inp, out, cc, cr, model, cc5m, cc1h] of seen.values()) {
    const d = ensure(days, dayKey(t));
    d.claude.in += inp; d.claude.cacheWrite += cc; d.claude.out += out; d.claude.cacheRead += cr;
    const m = d.claudeModels[model] || (d.claudeModels[model] = {
      in: 0, out: 0, cc: 0, cr: 0, cc5m: 0, cc1h: 0
    });
    m.in += inp; m.out += out; m.cc += cc; m.cr += cr;
    m.cc5m += cc5m || 0; m.cc1h += cc1h || 0;
  }
  codexDailyTokens(days, ensure);
  grokDailyTokens(days, ensure);
  const st = getState();
  for (const [k, v] of Object.entries(st.orDaily || {})) ensure(days, k).openrouter.spend += v;

  // price everything at OpenRouter per-token rates
  const pricing = await fetchOrPricing();
  const unpriced = new Set();
  const pcache = new Map();
  const P = (m) => {
    if (pcache.has(m)) return pcache.get(m);
    const p = priceFor(pricing.map, m);
    pcache.set(m, p);
    if (!p) unpriced.add(m);
    return p;
  };
  for (const v of Object.values(days)) {
    for (const [m, x] of Object.entries(v.claudeModels)) {
      // Route through shared pricing so five-minute vs one-hour cache writes
      // use cacheWrite / cacheWrite1h the same way as fleet events.
      const priced = sharedPricing.priceTokens(m, {
        in: x.in,
        out: x.out,
        cache_read: x.cr,
        cache_write: x.cc,
        cache_write_5m: x.cc5m || 0,
        cache_write_1h: x.cc1h || 0
      }, { overrides: (CONFIG.pricing && CONFIG.pricing.overrides) || {} });
      if (!priced || priced.amount == null) { P(m); continue; }
      v.claude.est += priced.amount;
      v.claude.estFlat += priced.flatAmount || 0;
    }
    // All Codex usage priced at one reference model (default gpt-5.6-sol).
    // est = what OpenRouter would actually bill (cached input at its cache-read
    // rate); estFlat = sticker price, every input token at the full prompt rate.
    const codexRef = (CONFIG.pricing && CONFIG.pricing.codexPriceModel) || 'gpt-5.6-sol';
    const codexP = P(codexRef);
    for (const x of Object.values(v.codexModels)) {
      if (!codexP) continue;
      v.codex.est += x.in * codexP.prompt
        + x.cached * (codexP.cacheRead != null ? codexP.cacheRead : 0.1 * codexP.prompt)
        + x.out * codexP.completion;
      v.codex.estFlat += (x.in + x.cached) * codexP.prompt + x.out * codexP.completion;
    }
    for (const [m, tot] of Object.entries(v.grokModels)) {
      const p = P(m); if (!p) continue;
      v.grok.est += tot * (0.8 * p.prompt + 0.2 * p.completion); // no in/out split: blended, input-heavy
    }
    delete v.claudeModels; delete v.codexModels; delete v.grokModels;
  }

  // Persist daily aggregates and merge with stored history (element-wise max):
  // source logs can be pruned or deleted, but the panel's own record survives.
  // Merge with the panel's own persisted record so pruned, deleted or
  // relocated source logs cannot erase history.
  //
  // Tokens are facts and only ever grow, so the larger value wins. Estimates
  // are NOT max-merged: they are recomputed from current prices every run, and
  // taking the maximum would permanently lock in any past price spike, making
  // displayed totals ratchet upward and never correct themselves. Instead the
  // more complete reading of a day — whichever source has more tokens — supplies
  // both its tokens and its estimate together, keeping the two consistent.
  const stH = getState();
  const hist = stH.tokenHistory || {};
  if (stH.tokenDefinitionVersion !== 2) {
    // Before version 2 Codex `in` included cache reads as well as fresh input.
    // Convert saved history once so old days use the same disjoint categories
    // as new events and fleet totals.
    for (const day of Object.values(hist)) {
      if (day && day.codex) {
        day.codex.in = Math.max(0, Number(day.codex.in || 0) - Number(day.codex.cached || 0));
        const repriced = sharedPricing.priceTokens(
          (CONFIG.pricing && CONFIG.pricing.codexPriceModel) || 'gpt-5.6-sol',
          { in: day.codex.in, out: day.codex.out, cache_read: day.codex.cached }
        );
        day.codex.est = repriced.amount || 0;
        day.codex.estFlat = repriced.flatAmount || 0;
      }
    }
    stH.tokenDefinitionVersion = 2;
  }
  const mx = (a, b) => Math.max(a || 0, b || 0);

  /** Total tokens in one provider bucket, used to decide which reading is more complete. */
  const weigh = (b) => b ? (b.in || 0) + (b.out || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0)
    + (b.cached || 0) + (b.total || 0) : 0;

  for (const [k, v] of Object.entries(days)) {
    const h = hist[k];
    if (h) {
      // Claude
      if (weigh(h.claude) > weigh(v.claude)) {
        v.claude = Object.assign({}, h.claude);
      } else {
        v.claude.in = mx(v.claude.in, h.claude && h.claude.in);
        v.claude.out = mx(v.claude.out, h.claude && h.claude.out);
        v.claude.cacheWrite = mx(v.claude.cacheWrite, h.claude && h.claude.cacheWrite);
        v.claude.cacheRead = mx(v.claude.cacheRead, h.claude && h.claude.cacheRead);
      }
      // Codex
      if (weigh(h.codex) > weigh(v.codex)) {
        v.codex = Object.assign({}, h.codex);
      } else {
        v.codex.in = mx(v.codex.in, h.codex && h.codex.in);
        v.codex.out = mx(v.codex.out, h.codex && h.codex.out);
        v.codex.cached = mx(v.codex.cached, h.codex && h.codex.cached);
      }
      // Grok
      if (weigh(h.grok) > weigh(v.grok)) v.grok = Object.assign({}, h.grok);
      // OpenRouter spend is an accumulated dollar figure, not a token count.
      v.openrouter.spend = mx(v.openrouter.spend, h.openrouter && h.openrouter.spend);
    }
    hist[k] = v;
  }
  for (const [k, h] of Object.entries(hist)) {
    if (!days[k]) days[k] = h; // restore days whose logs are gone entirely
  }
  stH.tokenHistory = hist;
  saveState(stH);

  function rollup(keyFn) {
    const acc = {};
    for (const [k, v] of Object.entries(days)) {
      const rk = keyFn(k);
      const a = acc[rk] || (acc[rk] = ensure({}, 'x'));
      a.claude.in += v.claude.in; a.claude.out += v.claude.out; a.claude.cacheWrite += v.claude.cacheWrite; a.claude.cacheRead += v.claude.cacheRead; a.claude.est += v.claude.est; a.claude.estFlat += v.claude.estFlat || 0;
      a.codex.in += v.codex.in; a.codex.out += v.codex.out; a.codex.cached += v.codex.cached; a.codex.est += v.codex.est; a.codex.estFlat += v.codex.estFlat || 0;
      a.grok.total += v.grok.total; a.grok.est += v.grok.est;
      a.openrouter.spend += v.openrouter.spend;
    }
    return Object.entries(acc).map(([key, v]) => {
      delete v.claudeModels; delete v.codexModels; delete v.grokModels;
      return Object.assign({ key }, v);
    }).sort((a, b) => b.key.localeCompare(a.key));
  }
  const years = rollup((k) => k.slice(0, 4));
  const totals = {
    claude: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, est: 0, estFlat: 0 },
    codex: { in: 0, out: 0, cached: 0, est: 0, estFlat: 0 },
    grok: { total: 0, est: 0 },
    openrouter: { spend: 0 }
  };
  for (const y of years) {
    totals.claude.in += y.claude.in; totals.claude.out += y.claude.out; totals.claude.cacheWrite += y.claude.cacheWrite; totals.claude.cacheRead += y.claude.cacheRead; totals.claude.est += y.claude.est; totals.claude.estFlat += y.claude.estFlat || 0;
    totals.codex.in += y.codex.in; totals.codex.out += y.codex.out; totals.codex.cached += y.codex.cached; totals.codex.est += y.codex.est; totals.codex.estFlat += y.codex.estFlat || 0;
    totals.grok.total += y.grok.total; totals.grok.est += y.grok.est;
    totals.openrouter.spend += y.openrouter.spend;
  }
  totals.grand = totals.claude.est + totals.codex.est + totals.grok.est + totals.openrouter.spend;
  totals.grandFlat = (totals.claude.estFlat || 0) + (totals.codex.estFlat || 0) + totals.grok.est + totals.openrouter.spend;

  const data = {
    generatedAt: now,
    pricingAsOf: pricing.fetchedAt || null,
    pricingVersion: pricing.version || null,
    codexPriceModel: (CONFIG.pricing && CONFIG.pricing.codexPriceModel) || 'gpt-5.6-sol',
    unpriced: [...unpriced],
    // Log files too large to parse. Reported so a short total is never
    // presented as a complete one.
    skipped: [...skippedLogFiles].map((f) => path.basename(f)),
    scanWindowDays: scanWindowDays(),
    totals,
    days: rollup((k) => k),
    months: rollup((k) => k.slice(0, 7)),
    years
  };
  tokAggCache = { at: now, data };
  return data;
}

// ---------- pending placeholders ----------
function pending(label) { return { status: 'pending', kind: 'window', label, plan: 'subscription' }; }

// ---------- snapshot ----------
async function snapshot(force) {
  CONFIG = runtimeConfig.load(ROOT); // hot-reload user config and protected enrollment state
  if (force) { claudeCache.at = 0; claudeLogCache.at = 0; orCache.at = 0; }
  const state = getState();
  let claude, codex, openrouter, grok;
  try { claude = await collectClaude(force); } catch (e) { claude = { status: 'error', message: String(e) }; }
  try { codex = await collectCodex(); } catch (e) { codex = { status: 'error', message: String(e) }; }
  try { openrouter = await collectOpenRouter(state); } catch (e) { openrouter = { status: 'error', message: String(e) }; }
  try { grok = await collectGrok(state, force); } catch (e) { grok = { status: 'error', message: String(e) }; }
  return {
    generatedAt: Date.now(),
    buildId: BUILD_ID,
    pollSeconds: CONFIG.pollSeconds || 10,
    providers: {
      claude,
      codex,
      grok,
      kimi: pending('Kimi'),
      gemini: pending('Gemini'),
      openrouter
    }
  };
}

// ---------- harness usage (from the capture proxy's event store) ----------
// Fully dynamic: any harness that reports events appears here without code
// changes, which is what makes onboarding a new tool a config-only operation.
let harnessCache = { at: 0, data: null };

/**
 * Price a token bag for one model using the OpenRouter catalogue.
 * Mirrors the table's two-figure convention: `est` is what a provider would
 * actually bill (cached input at its cache rate), `estFlat` is sticker price.
 */
function priceTokens(map, model, tokens) {
  const priced = sharedPricing.priceTokens(model, tokens, {
    overrides: (CONFIG.pricing && CONFIG.pricing.overrides) || {}
  });
  return {
    est: priced.amount,
    estFlat: priced.flatAmount,
    status: priced.status,
    version: priced.version
  };
}

async function harnessUsage() {
  const now = Date.now();
  if (harnessCache.data && now - harnessCache.at < 30000) return harnessCache.data;

  const eventStore = require('./src/core/events');
  const pricing = await fetchOrPricing();
  const raw = eventStore.read({});
  const rolled = eventStore.rollup(raw);

  const unpriced = new Set();
  const days = [];
  const totals = {};

  for (const [day, harnesses] of Object.entries(rolled)) {
    const row = { key: day, harnesses: {} };
    for (const [harness, models] of Object.entries(harnesses)) {
      const agg = {
        tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0, unattributed: 0 },
        calls: 0, est: 0, estFlat: 0, models: {}
      };
      for (const [model, bucket] of Object.entries(models)) {
        const t = bucket.tokens;
        agg.tokens.in += t.in; agg.tokens.out += t.out;
        agg.tokens.cache_read += t.cache_read; agg.tokens.cache_write += t.cache_write;
        agg.tokens.reasoning += t.reasoning;
        agg.tokens.unattributed += t.unattributed || 0;
        agg.calls += bucket.calls;

        const priced = priceTokens(pricing.map, model, t);
        if (priced.est == null) unpriced.add(model);
        else { agg.est += priced.est; agg.estFlat += priced.estFlat; }

        const m = agg.models[model] || (agg.models[model] = { tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0, unattributed: 0 }, calls: 0, est: 0, provider: bucket.provider });
        m.tokens.in += t.in; m.tokens.out += t.out; m.tokens.cache_read += t.cache_read;
        m.tokens.cache_write += t.cache_write; m.tokens.unattributed += t.unattributed || 0;
        m.calls += bucket.calls;
        if (priced.est != null) m.est += priced.est;
      }
      row.harnesses[harness] = agg;

      const tot = totals[harness] || (totals[harness] = {
        tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0, unattributed: 0 },
        calls: 0, est: 0, estFlat: 0, models: {}
      });
      tot.tokens.in += agg.tokens.in; tot.tokens.out += agg.tokens.out;
      tot.tokens.cache_read += agg.tokens.cache_read; tot.tokens.cache_write += agg.tokens.cache_write;
      tot.tokens.reasoning += agg.tokens.reasoning; tot.tokens.unattributed += agg.tokens.unattributed;
      tot.calls += agg.calls; tot.est += agg.est; tot.estFlat += agg.estFlat;
      for (const [model, m] of Object.entries(agg.models)) {
        const tm = tot.models[model] || (tot.models[model] = { calls: 0, est: 0, provider: m.provider });
        tm.calls += m.calls; tm.est += m.est;
      }
    }
    days.push(row);
  }
  days.sort((a, b) => b.key.localeCompare(a.key));

  const data = {
    generatedAt: now,
    proxyEnabled: !!(CONFIG.proxy && CONFIG.proxy.enabled),
    proxyEndpoint: (CONFIG.proxy && CONFIG.proxy.enabled)
      ? 'http://' + ((CONFIG.proxy.host) || '127.0.0.1') + ':' + (CONFIG.proxy.port || 8898) + '/<harness>/<provider>/'
      : null,
    eventCount: raw.length,
    unpriced: [...unpriced],
    pricingAsOf: pricing.fetchedAt || null,
    pricingVersion: pricing.version || null,
    totals,
    days
  };
  harnessCache = { at: now, data };
  return data;
}

// ---------- server ----------

/**
 * Reject requests whose Host header is not a loopback name.
 *
 * The server binds 127.0.0.1, but that alone does not stop DNS rebinding: an
 * attacker's domain can be re-pointed at 127.0.0.1, after which a page on that
 * domain is same-origin with this server and can read every endpoint. Browsers
 * always send the original hostname in Host, so checking it closes the hole.
 *
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function hostAllowed(req) {
  const host = String(req.headers.host || '');
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/**
 * Endpoints with side effects must not be reachable by a cross-site GET.
 * Browsers send Sec-Fetch-Site on such requests; a same-origin fetch from the
 * dashboard itself reports 'same-origin'.
 *
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function sameSiteOk(req) {
  const site = req.headers['sec-fetch-site'];
  if (!site) return true; // non-browser client (curl, tests): allowed
  return site === 'same-origin' || site === 'none';
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }
    // Deny cross-site requests to anything that spends quota, bandwidth or
    // forces authenticated upstream calls.
    const sideEffecting = req.url.indexOf('force=1') !== -1;
    if (sideEffecting && !sameSiteOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-site request denied' }));
      return;
    }
    if (req.url === '/api/tokens') {
      let agg;
      try { agg = await aggregateTokens(); } catch (e) { agg = { error: String(e.message || e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(agg));
      return;
    }
    if (req.url === '/api/sync') {
      let payload;
      try {
        const cfg = CONFIG.sync || {};
        const configured = !!(cfg.endpoint && cfg.deviceCredential);
        const status = require('./src/sync/outbox').status();
        // Customer-visible state: plain words for re-link vs waiting vs healthy.
        let customerState = 'unconfigured';
        let customerMessage = 'This computer is not linked to Super ZT yet.';
        if (status.relinkRequired) {
          customerState = 'relink';
          customerMessage = status.lastError
            || 'This computer is no longer linked to Super ZT. Create a new link code and enroll again.';
        } else if (configured && (status.waitingTotal > 0 || status.pendingTotal > 0) && !status.lastSyncAt) {
          customerState = 'waiting';
          customerMessage = 'Usage is waiting to upload'
            + (status.oldestPendingDay ? ' (backlog from ' + status.oldestPendingDay + ')' : '') + '.';
        } else if (configured && status.lastError && !status.relinkRequired) {
          customerState = 'error';
          customerMessage = status.lastError;
        } else if (configured) {
          customerState = 'ok';
          customerMessage = status.lastSyncAt
            ? 'Linked. Last successful upload: ' + status.lastSyncAt
            : 'Linked. Waiting for the first upload.';
        }
        payload = Object.assign(
          {
            enabled: !!cfg.enabled,
            endpoint: cfg.endpoint || null,
            configured,
            customerState,
            customerMessage
          },
          status
        );
      } catch (e) { payload = { error: String(e.message || e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === '/api/detect') {
      let payload;
      try {
        payload = require('./src/detect').scan({
          homes: (CONFIG.paths && CONFIG.paths.harnessHomes) || {},
          proxy: {
            host: (CONFIG.proxy && CONFIG.proxy.host) || '127.0.0.1',
            port: (CONFIG.proxy && CONFIG.proxy.port) || 8898,
            enabled: !!(CONFIG.proxy && CONFIG.proxy.enabled),
            defaultProvider: (CONFIG.proxy && CONFIG.proxy.defaultProvider) || 'openrouter'
          }
        });
      } catch (e) { payload = { error: String(e.message || e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === '/api/harnesses' || req.url.indexOf('/api/harnesses?') === 0) {
      let payload;
      try { payload = await harnessUsage(); } catch (e) { payload = { error: String(e.message || e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === '/api/data' || req.url.indexOf('/api/data?') === 0) {
      const data = await snapshot(req.url.indexOf('force=1') !== -1);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    const iconMatch = req.url.match(/^\/logo-(192|256|512)\.png$/);
    if (iconMatch) {
      let png;
      try { png = fs.readFileSync(path.join(ROOT, 'icons', 'logo-' + iconMatch[1] + '.png')); }
      catch (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      res.end(png);
      return;
    }
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        name: 'Usage Panel',
        short_name: 'UsagePanel',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0b0b',
        theme_color: '#0a0b0b',
        icons: [
          { src: '/logo-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/logo-256.png', sizes: '256x256', type: 'image/png' },
          { src: '/logo-512.png', sizes: '512x512', type: 'image/png' }
        ]
      }));
      return;
    }
    if (req.url === '/favicon.ico') {
      let ico;
      try { ico = fs.readFileSync(path.join(ROOT, 'usage-panel.ico')); }
      catch (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'max-age=3600' });
      res.end(ico);
      return;
    }
    if (req.url === '/' || req.url === '/index.html' || req.url === '/dashboard.html') {
      let html;
      try { html = fs.readFileSync(HTML_PATH); }
      catch (e) { res.writeHead(500); res.end('dashboard.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    // Writing a header after the body has started throws, and inside an async
    // handler that would take the whole process down.
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String((e && e.message) || e));
    } else {
      res.destroy();
    }
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('Port ' + PORT + ' already in use — another instance is running. Exiting.');
    process.exit(66); // distinct code so the restart loop knows not to respawn
  }
  throw e;
});

// A dashboard is a long-running background process: a single stray rejection
// anywhere should degrade one card, not kill the panel.
process.on('unhandledRejection', (err) => {
  console.log('[warn] unhandled rejection: ' + ((err && err.message) || err));
});
process.on('uncaughtException', (err) => {
  console.log('[error] uncaught exception: ' + ((err && err.stack) || err));
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Usage Panel listening on http://localhost:' + PORT);
});

// ---------- capture proxy ----------
// BYOK harnesses (OpenCode, pi, CodeRabbit, Hermes, ...) do not reliably log
// which model served a request. Pointing them at this proxy records the truth
// off the wire. Disabled by default: it only listens once configured.
function startCaptureProxy() {
  const cfg = (CONFIG.proxy || {});
  if (!cfg.enabled) return;

  const { createProxyServer } = require('./src/proxy');
  const eventStore = require('./src/core/events');
  const { identity } = require('./src/core/device');
  const device = identity(cfg.deviceLabel);

  // Writes are batched off the hot path, so anything still queued must be
  // flushed before exit or the last few calls are lost.
  eventStore.onError((err) => console.log('[events] write failed: ' + err.message));
  let flushing = false;
  const flushAndExit = (code) => {
    if (flushing) return;
    flushing = true;
    eventStore.flush().then(() => process.exit(code)).catch(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };
  process.on('SIGINT', () => flushAndExit(0));
  process.on('SIGTERM', () => flushAndExit(0));
  process.on('beforeExit', () => { eventStore.flush(); });

  const proxy = createProxyServer({
    providers: cfg.providers || {},
    injectUsageReporting: cfg.injectUsageReporting !== false,
    log: (msg) => console.log('[proxy] ' + msg),
    onEvent: (ev) => {
      if (!ev.usage) return; // nothing measurable to record
      const pricedModel = sharedPricing.resolve(
        ev.model,
        (CONFIG.pricing && CONFIG.pricing.overrides) || {}
      );
      // Carry Codex evidence fields through unchanged so the store and the
      // portal serializer never invent verification that the wire did not prove.
      const result = eventStore.append({
        device_id: device.id,
        harness: ev.harness,
        harness_evidence: ev.harnessEvidence || ev.harness_evidence || 'configured_route',
        harness_verified: ev.harnessVerified === true || ev.harness_verified === true,
        provider: ev.provider,
        model: ev.model,
        model_evidence: ev.modelEvidence || ev.model_evidence || 'unknown',
        model_verified: ev.modelVerified === true || ev.model_verified === true,
        pricing_model: pricedModel ? pricedModel.id : null,
        ts: ev.ts,
        tokens: ev.usage,
        source: 'proxy',
        request_id: ev.requestId,
        duration_ms: ev.durationMs,
        status: ev.status
      });
      // Invalidate derived views so new usage appears on the next poll, and
      // wake the sync loop so the collector sees it within seconds.
      if (result.written) {
        tokAggCache.at = 0;
        harnessCache.at = 0;
        notifyNewUsage();
      }
    }
  });

  proxy.on('error', (e) => {
    console.log('[proxy] listen failed: ' + (e && e.message));
  });
  const host = cfg.host || '127.0.0.1';
  const port = cfg.port || 8898;
  proxy.listen(port, host, () => {
    console.log('Capture proxy listening on http://' + host + ':' + port + '/<harness>/<provider>/');
  });
}

try { startCaptureProxy(); } catch (e) {
  console.log('[proxy] disabled: ' + (e && e.message));
}

// ---------- fleet sync ----------
// Pushes this device's usage to a central collector. Delivery is at-least-once
// and the collector deduplicates by event id, so a failed or repeated send can
// never inflate the fleet totals.
function startSync() {
  const cfg = (CONFIG.sync || {});
  if (!cfg.enabled) return;
  if (!cfg.endpoint || !cfg.deviceCredential) {
    console.log('[sync] enabled but not configured — enroll this device with a company code');
    return;
  }

  const client = require('./src/sync/client');
  const eventStore = require('./src/core/events');

  // Two cadences: a short debounce so captured usage reaches the collector
  // within seconds, and a slow interval that retries anything left pending
  // after an outage. The debounce coalesces bursts — a busy agent session
  // produces one push, not one per call.
  const liveDelayMs = Math.max(1, Number(cfg.liveDelaySeconds) || 5) * 1000;
  const localPollMs = Math.max(5, Number(cfg.localPollSeconds) || 15) * 1000;
  const intervalMs = Math.max(1, Number(cfg.intervalMinutes) || 5) * 60 * 1000;

  let running = false;
  let pendingTimer = null;
  let rerunRequested = false;

  const tick = async () => {
    if (running) { rerunRequested = true; return; }
    running = true;
    try {
      await bridgeLocalUsage();
      await eventStore.flush(); // never ship a partially written queue
      const result = await client.push(cfg);
      if (result.sent) console.log('[sync] pushed ' + result.sent + ' events');
      else if (!result.ok) console.log('[sync] ' + result.message);
    } catch (err) {
      console.log('[sync] failed: ' + (err && err.message));
    } finally {
      running = false;
      if (rerunRequested) { rerunRequested = false; schedule(liveDelayMs); }
    }
  };

  /** @param {number} delayMs */
  const schedule = (delayMs) => {
    if (pendingTimer) return; // already coalescing
    pendingTimer = setTimeout(() => { pendingTimer = null; tick(); }, delayMs);
    if (pendingTimer.unref) pendingTimer.unref();
  };

  notifyNewUsage = () => schedule(liveDelayMs);

  schedule(15000);                        // settle before the first push
  setInterval(() => { bridgeLocalUsage(); }, localPollMs).unref();
  setInterval(() => schedule(0), intervalMs).unref(); // retry backstop
  console.log('Fleet sync enabled -> ' + cfg.endpoint
    + ' (proxy: ~' + (liveDelayMs / 1000) + 's, local logs: ~'
    + ((localPollMs + liveDelayMs) / 1000) + 's, retry every ' + (intervalMs / 60000) + 'm)');
}

try { startSync(); } catch (e) {
  console.log('[sync] disabled: ' + (e && e.message));
}
