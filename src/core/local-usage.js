'use strict';

/**
 * Incremental bridge from local subscription logs to uploadable usage events.
 *
 * The source logs may contain prompts, completions, file paths and credentials.
 * This module never copies a source object into an event. It constructs a
 * strict allowlist containing only model identity, timestamp and token facts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');

const { dataDir, ensureDir } = require('./paths');

const STATE_VERSION = 2;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** @returns {string} */
function checkpointPath() {
  return path.join(dataDir(), 'local-usage-checkpoints.json');
}

/** @returns {{version:number,files:Record<string,object>,claude:Record<string,object>}} */
function loadCheckpoints() {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath(), 'utf8'));
    return {
      version: STATE_VERSION,
      files: parsed && parsed.version === STATE_VERSION && parsed.files
        ? parsed.files
        : {},
      claude: parsed && parsed.version === STATE_VERSION && parsed.claude
        ? parsed.claude
        : {}
    };
  } catch (_) {
    return { version: STATE_VERSION, files: {}, claude: {} };
  }
}

/** @param {{version:number,files:Record<string,object>,claude:Record<string,object>}} state */
function saveCheckpoints(state) {
  ensureDir(dataDir());
  const file = checkpointPath();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
}

/** @param {string} value @returns {string} */
function stableId(value) {
  return 'local_' + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/** @param {any} value @returns {number} */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Read Anthropic cache-write totals, preserving five-minute vs one-hour TTL
 * when `cache_creation` is present. Aggregate-only rows keep duration fields
 * at zero so legacy pricing continues to use the five-minute rate.
 * @param {object} usage
 * @returns {{in:number,out:number,cache_read:number,cache_write:number,cache_write_5m:number,cache_write_1h:number,reasoning:number,unattributed:number}}
 */
function claudeTokensFromUsage(usage) {
  const u = usage || {};
  const creation = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const five = creation ? count(creation.ephemeral_5m_input_tokens) : 0;
  const oneHour = creation ? count(creation.ephemeral_1h_input_tokens) : 0;
  const aggregate = count(u.cache_creation_input_tokens);
  return {
    in: count(u.input_tokens),
    out: count(u.output_tokens),
    cache_read: count(u.cache_read_input_tokens),
    cache_write: aggregate || (five + oneHour),
    cache_write_5m: five,
    cache_write_1h: oneHour,
    reasoning: 0,
    unattributed: 0
  };
}

/**
 * Component-wise maximum used by both the employee aggregate and uploader for
 * repeated Claude rows with progressively growing usage.
 * @param {object} previous
 * @param {object} current
 * @returns {{in:number,out:number,cache_read:number,cache_write:number,cache_write_5m:number,cache_write_1h:number}}
 */
function mergeClaudeTokens(previous, current) {
  const before = previous || {};
  const next = current || {};
  return {
    in: Math.max(count(before.in), count(next.in)),
    out: Math.max(count(before.out), count(next.out)),
    cache_read: Math.max(count(before.cache_read), count(next.cache_read)),
    cache_write: Math.max(count(before.cache_write), count(next.cache_write)),
    cache_write_5m: Math.max(count(before.cache_write_5m), count(next.cache_write_5m)),
    cache_write_1h: Math.max(count(before.cache_write_1h), count(next.cache_write_1h))
  };
}

/**
 * Emit only new Claude token facts since the durable ledger high-water mark.
 *
 * Duration fields can appear late on a progressive row after an earlier
 * aggregate-only sighting already billed part of `cache_write`. Duration
 * deltas are therefore hard-capped by the aggregate `cache_write` delta so
 * the same tokens cannot be emitted twice (once as legacy aggregate, again
 * as a full 5m/1h absolute). Tokens of known duration that the cap discards
 * are recorded on `cache_write_unresolved` so pricing can mark the event
 * partial instead of presenting an exact underbill. Pure aggregate growth
 * after a prior duration-attributed sighting is likewise unresolved: the
 * panel must not claim an exact five-minute rate for that growth.
 *
 * @param {object} previous highest previously recorded absolute tokens
 * @param {object} highest merged absolute tokens after this sighting
 * @returns {{in:number,out:number,cache_read:number,cache_write:number,cache_write_5m:number,cache_write_1h:number,cache_write_unresolved:number,reasoning:number,unattributed:number}}
 */
function claudeTokenTopUp(previous, highest) {
  const before = previous || {};
  const after = highest || {};
  const writeDelta = Math.max(0, count(after.cache_write) - count(before.cache_write));
  const rawFiveDelta = Math.max(0, count(after.cache_write_5m) - count(before.cache_write_5m));
  const rawOneHourDelta = Math.max(0, count(after.cache_write_1h) - count(before.cache_write_1h));

  // Bound each duration delta and their sum by the aggregate write delta.
  const fiveDelta = Math.min(rawFiveDelta, writeDelta);
  const oneHourDelta = Math.min(rawOneHourDelta, writeDelta - fiveDelta);
  // Known duration that would double-count already-emitted aggregate writes.
  let unresolved = (rawFiveDelta - fiveDelta) + (rawOneHourDelta - oneHourDelta);

  // Aggregate-only growth after a duration-attributed sighting: do not claim
  // an exact five-minute price for the new slice.
  const priorDuration = count(before.cache_write_5m) + count(before.cache_write_1h);
  if (writeDelta > 0 && fiveDelta + oneHourDelta === 0 && priorDuration > 0) {
    unresolved += writeDelta;
  }

  return {
    in: Math.max(0, count(after.in) - count(before.in)),
    out: Math.max(0, count(after.out) - count(before.out)),
    cache_read: Math.max(0, count(after.cache_read) - count(before.cache_read)),
    cache_write: writeDelta,
    cache_write_5m: fiveDelta,
    cache_write_1h: oneHourDelta,
    cache_write_unresolved: unresolved,
    reasoning: 0,
    unattributed: 0
  };
}

/**
 * Walk a source directory without following symlinks.
 * @param {string} root
 * @param {(file:string) => boolean} accept
 * @returns {string[]}
 */
function walk(root, accept) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && accept(full)) out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

/**
 * Process only bytes not covered by the durable checkpoint. A final partial
 * JSON line stays pending until its writer completes it.
 *
 * @param {string} file
 * @param {object} checkpoint
 * @param {(line:string,state:object) => void} onLine
 * @returns {object} next checkpoint
 */
function scanIncremental(file, checkpoint, onLine) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) return Object.assign({}, checkpoint, { skipped: 'too-large' });

  const previous = checkpoint || {};
  const sameFile = previous.ino == null || previous.dev == null
    || (String(previous.ino) === String(stat.ino) && String(previous.dev) === String(stat.dev));
  const start = sameFile && Number(previous.offset) >= 0 && Number(previous.offset) <= stat.size
    ? Number(previous.offset)
    : 0;
  const runtime = Object.assign({}, start ? (previous.runtime || {}) : {});
  const handle = fs.openSync(file, 'r');
  let position = start;
  let pending = Buffer.alloc(0);
  let committed = start;
  let endStat;
  try {
    const block = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, stat.size - start)));
    while (position < stat.size) {
      const bytes = fs.readSync(handle, block, 0, Math.min(block.length, stat.size - position), position);
      if (!bytes) break;
      position += bytes;
      pending = pending.length
        ? Buffer.concat([pending, block.subarray(0, bytes)])
        : Buffer.from(block.subarray(0, bytes));

      let cursor = 0;
      for (;;) {
        const newline = pending.indexOf(10, cursor);
        if (newline === -1) break;
        const line = pending.subarray(cursor, newline).toString('utf8').replace(/\r$/, '');
        if (line.trim()) onLine(line, runtime);
        committed += newline - cursor + 1;
        cursor = newline + 1;
      }
      if (cursor) pending = Buffer.from(pending.subarray(cursor));
    }
    endStat = fs.fstatSync(handle);

    const stableEnd = position === stat.size
      && endStat.size === stat.size
      && String(endStat.ino) === String(stat.ino)
      && String(endStat.dev) === String(stat.dev)
      && endStat.mtimeMs === stat.mtimeMs
      && endStat.ctimeMs === stat.ctimeMs;
    if (pending.length && stableEnd) {
      let line = null;
      try {
        const decoded = STRICT_UTF8.decode(pending).replace(/\r$/, '');
        if (decoded.trim()) {
          JSON.parse(decoded);
          line = decoded;
        }
      } catch (_) {
        // The writer may still be completing JSON or a split UTF-8 sequence.
      }
      if (line !== null) {
        onLine(line, runtime);
        committed += pending.length;
        pending = Buffer.alloc(0);
      }
    }
  } finally {
    fs.closeSync(handle);
  }

  return {
    offset: committed,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
    dev: stat.dev,
    runtime
  };
}

/**
 * Claude Code can copy one assistant reply into several transcript files and
 * can write progressively larger usage totals for that same reply. The
 * durable ledger below records the highest value seen for each category. A
 * repeated row emits nothing; a larger row emits only the top-up.
 *
 * Identity deliberately excludes timestamp and token counts. Those fields
 * change across copies of the same reply and were the cause of fleet totals
 * being roughly twice the employee total.
 *
 * @param {string} line
 * @param {string} deviceId
 * @param {Record<string,object>} [ledger]
 * @returns {object|null}
 */
function claudeEvent(line, deviceId, ledger) {
  let row;
  try { row = JSON.parse(line); } catch (_) { return null; }
  const message = row && row.message;
  const usage = message && message.usage;
  if (row.type !== 'assistant' || !usage) return null;
  const timestamp = new Date(row.timestamp);
  if (isNaN(timestamp.getTime())) return null;

  const absolute = claudeTokensFromUsage(usage);
  if (!absolute.in && !absolute.out && !absolute.cache_read && !absolute.cache_write) return null;

  const model = typeof message.model === 'string' ? message.model : 'unknown';
  const messageId = typeof message.id === 'string' ? message.id : '';
  const requestId = typeof row.requestId === 'string' ? row.requestId : '';
  const fallbackId = typeof row.uuid === 'string' ? row.uuid : timestamp.toISOString();
  const identity = messageId || requestId
    ? messageId + '|' + requestId
    : 'fallback|' + fallbackId;
  const identityHash = stableId('claude-identity|' + identity);
  const state = ledger || {};
  const previous = state[identityHash] || {
    tokens: {
      in: 0, out: 0, cache_read: 0, cache_write: 0,
      cache_write_5m: 0, cache_write_1h: 0, cache_write_unresolved: 0
    },
    ts: timestamp.toISOString(),
    model
  };
  const highest = mergeClaudeTokens(previous.tokens, absolute);
  const tokens = claudeTokenTopUp(previous.tokens, highest);
  const canonicalTs = previous.ts || timestamp.toISOString();
  const canonicalModel = model !== 'unknown' ? model : (previous.model || model);
  state[identityHash] = { tokens: highest, ts: canonicalTs, model: canonicalModel };
  if (!tokens.in && !tokens.out && !tokens.cache_read && !tokens.cache_write) return null;

  const sourceKey = [
    'claude', deviceId, identityHash,
    highest.in, highest.out, highest.cache_read, highest.cache_write,
    highest.cache_write_5m, highest.cache_write_1h
  ].join('|');
  return {
    event_id: stableId(sourceKey),
    device_id: deviceId,
    harness: 'claude-code',
    provider: 'anthropic',
    model: canonicalModel,
    ts: canonicalTs,
    tokens,
    source: 'local_log',
    request_id: null,
    session_id: null
  };
}

/**
 * Codex reports cumulative input with cached input included. Split that into
 * the same mutually exclusive categories used by events and fleet totals.
 * @param {number} input
 * @param {number} cached
 * @param {number} [cacheWrite]
 * @returns {{in:number,cache_read:number,cache_write:number}}
 */
function splitCodexInput(input, cached, cacheWrite) {
  const total = count(input);
  const cacheRead = Math.min(total, count(cached));
  const written = Math.min(total - cacheRead, count(cacheWrite));
  return { in: total - cacheRead - written, cache_read: cacheRead, cache_write: written };
}

/**
 * Process one Codex rollout line. The runtime carries cumulative counters from
 * the prior line so the emitted event contains only the new delta.
 *
 * @param {string} line
 * @param {string} deviceId
 * @param {string} streamId
 * @param {object} runtime
 * @param {string} [pricingModel]
 * @returns {object|null}
 */
function codexEvent(line, deviceId, streamId, runtime, pricingModel) {
  let row;
  try { row = JSON.parse(line); } catch (_) { return null; }
  const payload = row && row.payload;
  if (payload && typeof payload.model === 'string') runtime.model = payload.model;
  if (row && typeof row.model === 'string') runtime.model = row.model;

  const usage = payload && payload.info && payload.info.total_token_usage;
  if (!usage) return null;
  const timestamp = new Date(row.timestamp);
  if (isNaN(timestamp.getTime())) return null;

  const previous = runtime.totals || { in: 0, out: 0, cache: 0, cacheWrite: 0, reasoning: 0 };
  const cacheWriteKnown = Object.prototype.hasOwnProperty.call(usage, 'cache_write_input_tokens');
  const current = {
    in: count(usage.input_tokens),
    out: count(usage.output_tokens),
    cache: count(usage.cached_input_tokens),
    // An omitted cumulative field is unknown, not a reset to zero. Retain the
    // previous known total so a later row cannot duplicate cache-write usage.
    cacheWrite: cacheWriteKnown ? count(usage.cache_write_input_tokens) : count(previous.cacheWrite),
    reasoning: count(usage.reasoning_output_tokens)
  };
  const reset = current.in < previous.in || current.out < previous.out || current.cache < previous.cache
    || (cacheWriteKnown && current.cacheWrite < count(previous.cacheWrite));
  // A source-counter reset starts a new cumulative epoch. If that reset row
  // omits cache-write usage, the prior epoch's known value must not be carried
  // forward and misreported as a write in the new epoch.
  if (reset && !cacheWriteKnown) current.cacheWrite = 0;
  const base = reset ? { in: 0, out: 0, cache: 0, cacheWrite: 0, reasoning: 0 } : previous;
  const inputDelta = Math.max(0, current.in - base.in);
  const cacheDelta = Math.min(inputDelta, Math.max(0, current.cache - base.cache));
  const cacheWriteDelta = Math.min(
    Math.max(0, inputDelta - cacheDelta),
    Math.max(0, current.cacheWrite - count(base.cacheWrite))
  );
  const outputDelta = Math.max(0, current.out - base.out);
  const reasoningDelta = Math.max(0, current.reasoning - base.reasoning);
  runtime.totals = current;

  if (!inputDelta && !outputDelta && !cacheDelta) return null;
  const model = runtime.model || 'unknown';
  const splitInput = splitCodexInput(inputDelta, cacheDelta, cacheWriteDelta);
  const tokens = {
    in: splitInput.in,
    out: outputDelta,
    cache_read: splitInput.cache_read,
    cache_write: splitInput.cache_write,
    reasoning: reasoningDelta,
    unattributed: 0,
    missing: cacheWriteKnown ? [] : ['cache_write']
  };
  const sourceKey = [
    'codex', deviceId, streamId, timestamp.toISOString(), model,
    current.in, current.out, current.cache, current.cacheWrite, current.reasoning,
    cacheWriteKnown ? 'cache-write-known' : 'cache-write-unknown'
  ].join('|');
  return {
    event_id: stableId(sourceKey),
    device_id: deviceId,
    harness: 'codex',
    provider: 'openai',
    model,
    pricing_model: model === 'unknown' ? null : (pricingModel || model),
    ts: timestamp.toISOString(),
    tokens,
    source: 'local_log',
    request_id: null,
    session_id: streamId
  };
}

/**
 * Grok Build exposes a cumulative total but no input/output split. Preserve the
 * fact as `unattributed`; shared pricing marks its estimate partial.
 *
 * @param {string} line
 * @param {string} deviceId
 * @param {string} streamId
 * @param {string} model
 * @param {object} runtime
 * @returns {object|null}
 */
function grokEvent(line, deviceId, streamId, model, runtime) {
  let row;
  try { row = JSON.parse(line); } catch (_) { return null; }
  const encoded = JSON.stringify(row);
  const totalMatch = encoded.match(/"totalTokens":(\d+)/);
  const timeMatch = encoded.match(/"timestamp":(\d+)/);
  if (!totalMatch || !timeMatch) return null;
  const current = count(totalMatch[1]);
  const previous = count(runtime.total);
  const delta = current >= previous ? current - previous : current;
  runtime.total = current;
  if (!delta) return null;

  const timestamp = new Date(Number(timeMatch[1]) * 1000);
  if (isNaN(timestamp.getTime())) return null;
  // Never invent a model id. Only summary.current_model_id (or an explicit
  // caller-supplied value) is a fact; silence becomes "unknown".
  const resolvedModel = (typeof model === 'string' && model.trim()) ? model.trim() : 'unknown';
  return {
    event_id: stableId(['grok', deviceId, streamId, timestamp.toISOString(), resolvedModel, current].join('|')),
    device_id: deviceId,
    harness: 'grok-build',
    provider: 'x-ai',
    model: resolvedModel,
    ts: timestamp.toISOString(),
    tokens: { in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0, unattributed: delta },
    source: 'local_log',
    request_id: null,
    session_id: streamId
  };
}

/**
 * Scan all supported local subscription logs and append new token facts.
 * @param {object} options
 * @param {string} options.claudeHome
 * @param {string} options.codexHome
 * @param {string} options.grokHome
 * @param {{id:string}} options.device
 * @param {string} [options.codexPriceModel]
 * @param {number} [options.lookbackDays=45]
 * @param {{append:(event:object)=>object,flush:()=>Promise<void>}} options.eventStore
 * @returns {Promise<{written:number,duplicates:number,files:number,skipped:number}>}
 */
async function bridge(options) {
  const eventStore = options.eventStore;
  const deviceId = options.device.id;
  const state = loadCheckpoints();
  state.claude = state.claude || {};
  const seenFiles = new Set();
  let written = 0;
  let duplicates = 0;
  let skipped = 0;
  const lookbackDays = Number(options.lookbackDays) > 0 ? Number(options.lookbackDays) : 45;
  const cutoff = Date.now() - lookbackDays * 24 * 3600 * 1000;
  const recent = (file) => {
    try { return fs.statSync(file).mtimeMs >= cutoff; } catch (_) { return false; }
  };

  const append = (event) => {
    if (!event) return;
    const result = eventStore.append(event);
    if (result.written) written++;
    else if (result.reason === 'duplicate') duplicates++;
  };

  const scan = (file, kind, handler) => {
    const key = kind + ':' + path.resolve(file);
    seenFiles.add(key);
    const previous = state.files[key] || {};
    try {
      const next = scanIncremental(file, previous, handler);
      if (next.skipped) skipped++;
      state.files[key] = next;
    } catch (_) {
      skipped++;
    }
  };

  const claudeRoot = path.join(options.claudeHome, 'projects');
  for (const file of walk(claudeRoot, (name) => name.endsWith('.jsonl') && recent(name))) {
    scan(file, 'claude', (line) => append(claudeEvent(line, deviceId, state.claude)));
  }

  const codexRoots = [path.join(options.codexHome, 'sessions'), path.join(options.codexHome, 'archived_sessions')];
  for (const root of codexRoots) {
    for (const file of walk(root, (name) => /rollout-.*\.jsonl$/.test(name) && recent(name))) {
      const streamId = path.basename(file, '.jsonl');
      scan(file, 'codex', (line, runtime) => append(codexEvent(
        line, deviceId, streamId, runtime, options.codexPriceModel
      )));
    }
  }

  const grokRoot = path.join(options.grokHome, 'sessions');
  for (const file of walk(grokRoot, (name) => name.endsWith('updates.jsonl') && recent(name))) {
    const streamId = path.basename(path.dirname(file));
    const summary = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'summary.json'), 'utf8')); }
      catch (_) { return null; }
    })();
    const model = summary && typeof summary.current_model_id === 'string' && summary.current_model_id.trim()
      ? String(summary.current_model_id).trim()
      : null;
    scan(file, 'grok', (line, runtime) => append(grokEvent(line, deviceId, streamId, model, runtime)));
  }

  // Do not retain checkpoints for files that no longer exist. If a source log
  // later returns, stable event ids still protect against replay duplication.
  for (const key of Object.keys(state.files)) if (!seenFiles.has(key)) delete state.files[key];
  for (const [key, value] of Object.entries(state.claude)) {
    const ts = Date.parse(value && value.ts);
    if (!Number.isFinite(ts) || ts < cutoff) delete state.claude[key];
  }

  await eventStore.flush();
  saveCheckpoints(state);
  return { written, duplicates, files: seenFiles.size, skipped };
}

module.exports = {
  bridge,
  claudeTokensFromUsage,
  claudeTokenTopUp,
  claudeEvent,
  codexEvent,
  grokEvent,
  stableId,
  loadCheckpoints,
  checkpointPath,
  scanIncremental,
  splitCodexInput,
  mergeClaudeTokens
};
