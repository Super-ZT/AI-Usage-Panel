'use strict';

/**
 * Append-only usage event store.
 *
 * Events record *facts* — which harness called which model and how many tokens
 * it consumed. Cost is deliberately not stored: it is derived at query time
 * from the pricing catalogue, so a price correction never requires rewriting
 * history, and a central collector receives facts rather than one device's
 * opinion of cost.
 *
 * Every event carries a stable `event_id`. Appending the same event twice — on
 * retry, restart, or replay from another device — is a no-op, which is what
 * makes fleet-wide aggregation safe.
 *
 * Storage layout: <dataDir>/events/YYYY-MM-DD.jsonl (UTC days, one JSON per line)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { dataDir, ensureDir } = require('./paths');

/**
 * @typedef {object} UsageEvent
 * @property {string} event_id   stable idempotency key
 * @property {string} device_id
 * @property {string} harness    'claude-code' | 'opencode' | 'pi' | ...
 * @property {'configured_route'|'local_log'|'official_api'|'unknown'} harness_evidence
 * @property {false} harness_verified no current client evidence attests the calling process
 * @property {string} provider   'anthropic' | 'openrouter' | ...
 * @property {string|null} model model safe for downstream display
 * @property {string|null} [observed_model] unverified model reported by a custom upstream
 * @property {string|null} [requested_model] model supplied in the request
 * @property {'provider_response'|'local_log'|'requested_only'|'unknown'} model_evidence
 * @property {boolean} model_verified whether `model` came from a built-in HTTPS provider response
 * @property {string|null} [pricing_model] OpenRouter reference model when source billing uses one
 * @property {string} ts         ISO-8601 UTC
 * @property {{in:number,out:number,cache_read:number,cache_write:number,cache_write_5m:number,cache_write_1h:number,cache_write_unresolved:number,reasoning:number,unattributed:number,missing?:string[]}} tokens
 * @property {'proxy'|'local_log'|'official_api'} source provenance
 * @property {string|null} [session_id]
 * @property {string|null} [request_id]
 * @property {number} [duration_ms]
 * @property {number} [status]
 */

/** In-memory index of event ids already written, keyed by UTC day. */
const seenByDay = new Map();

const HARNESS_EVIDENCE = new Set(['configured_route', 'local_log', 'official_api', 'unknown']);
const MODEL_EVIDENCE = new Set(['provider_response', 'local_log', 'requested_only', 'unknown']);

/** @param {any} input @param {'harness'|'model'} kind @returns {string} */
function evidenceValue(input, kind) {
  const snake = kind + '_evidence';
  const camel = kind + 'Evidence';
  if (input[snake] != null) return String(input[snake]);
  if (input[camel] != null) return String(input[camel]);
  if (input.source === 'local_log') return 'local_log';
  if (input.source === 'official_api') return kind === 'harness' ? 'official_api' : 'unknown';
  return 'unknown';
}

/**
 * @param {string|number|Date} ts
 * @returns {string} YYYY-MM-DD in UTC; falls back to today for unparseable input
 *          so a single malformed record cannot abort an import.
 */
function utcDay(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** @returns {string} absolute path to the events directory */
function eventsDir() {
  return path.join(dataDir(), 'events');
}

/** @param {string} day @returns {string} absolute path to that day's log */
function dayFile(day) {
  return path.join(eventsDir(), day + '.jsonl');
}

/**
 * Derive a stable idempotency key.
 *
 * A provider-supplied request id is preferred because it survives clock skew
 * and retries. Without one, the natural key is the device, harness, timestamp
 * and token counts — identical enough to catch exact replays without merging
 * genuinely distinct calls.
 *
 * @param {Partial<UsageEvent>} ev
 * @returns {string}
 */
function deriveEventId(ev) {
  const t = ev.tokens || {};
  // The provider must participate in the key: request ids are only unique
  // within a provider, and self-hosted runtimes reuse short ids across
  // restarts. Omitting it silently drops genuine events as "duplicates".
  let natural;
  if (ev.request_id) {
    natural = [ev.device_id, ev.harness, ev.provider, utcDay(ev.ts), ev.request_id].join('|');
  } else {
    const parts = [
      ev.device_id, ev.harness, ev.provider, ev.model, ev.ts,
      t.in, t.out, t.cache_read, t.cache_write, t.cache_write_5m, t.cache_write_1h,
      t.cache_write_unresolved, t.reasoning, t.unattributed,
      ev.duration_ms == null ? '' : ev.duration_ms
    ];
    const missing = Array.isArray(t.missing) ? [...t.missing].sort() : [];
    // Preserve every pre-existing exact event id. Only partial events need an
    // extra discriminator so they cannot collide with otherwise equal exact facts.
    if (missing.length) parts.push('missing:' + missing.join(','));
    natural = parts.join('|');
  }
  return crypto.createHash('sha256').update(natural).digest('hex').slice(0, 32);
}

/**
 * Load the set of event ids already present in a day's file.
 * @param {string} day
 * @returns {Set<string>}
 */
function loadSeen(day) {
  if (seenByDay.has(day)) return seenByDay.get(day);
  const set = new Set();
  try {
    const raw = fs.readFileSync(dayFile(day), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      // Parse properly rather than scanning for a literal: a central collector
      // merging files may serialise with different spacing or key order, and a
      // missed id becomes a duplicate at rollup.
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.event_id) set.add(parsed.event_id);
      } catch (_) { /* torn line: nothing to dedupe on */ }
    }
  } catch (_) { /* no file yet */ }

  seenByDay.set(day, set);
  // Bound memory: only the current and previous UTC day stay resident. Older
  // days are re-read from disk on the rare occasion they are appended to.
  if (seenByDay.size > 2) {
    const keep = new Set([utcDay(Date.now()), utcDay(Date.now() - 86400000), day]);
    for (const key of seenByDay.keys()) if (!keep.has(key)) seenByDay.delete(key);
  }
  return set;
}

/**
 * Normalise a token bag, tolerating partial input.
 * Duration-specific cache-write fields are optional; older records only have
 * aggregate `cache_write` and remain valid.
 * @param {any} t
 * @returns {{in:number,out:number,cache_read:number,cache_write:number,cache_write_5m:number,cache_write_1h:number,cache_write_unresolved:number,reasoning:number,unattributed:number,missing?:string[]}}
 */
function normalizeTokens(t) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
  };
  t = t || {};
  const allowedMissing = new Set(['in', 'out', 'cache_read', 'cache_write']);
  const missing = Array.isArray(t.missing)
    ? [...new Set(t.missing.filter((name) => typeof name === 'string' && allowedMissing.has(name)))]
    : [];
  const normalized = {
    in: n(t.in != null ? t.in : t.input),
    out: n(t.out != null ? t.out : t.output),
    cache_read: n(t.cache_read != null ? t.cache_read : t.cacheRead),
    cache_write: n(t.cache_write != null ? t.cache_write : t.cacheWrite),
    cache_write_5m: n(t.cache_write_5m != null ? t.cache_write_5m : t.cacheWrite5m),
    cache_write_1h: n(t.cache_write_1h != null ? t.cache_write_1h : t.cacheWrite1h),
    cache_write_unresolved: n(
      t.cache_write_unresolved != null ? t.cache_write_unresolved : t.cacheWriteUnresolved
    ),
    reasoning: n(t.reasoning),
    unattributed: n(t.unattributed != null ? t.unattributed : t.unknown)
  };
  if (missing.length) normalized.missing = missing;
  return normalized;
}

/**
 * Append one usage event.
 *
 * @param {Partial<UsageEvent>} input
 * @returns {{written:boolean, event:UsageEvent|null, reason?:string}}
 */
function append(input) {
  if (!input || !input.harness) return { written: false, event: null, reason: 'missing harness' };

  const harnessEvidence = evidenceValue(input, 'harness');
  const modelEvidence = evidenceValue(input, 'model');
  if (!HARNESS_EVIDENCE.has(harnessEvidence)) {
    return { written: false, event: null, reason: 'invalid harness evidence' };
  }
  if (!MODEL_EVIDENCE.has(modelEvidence)) {
    return { written: false, event: null, reason: 'invalid model evidence' };
  }
  const modelVerified = input.model_verified === true || input.modelVerified === true;
  const harnessVerified = input.harness_verified === true || input.harnessVerified === true;
  if (harnessVerified) {
    return { written: false, event: null, reason: 'invalid harness verification' };
  }
  if (modelVerified && modelEvidence !== 'provider_response') {
    return { written: false, event: null, reason: 'invalid model verification' };
  }

  const tokens = normalizeTokens(input.tokens);
  // An event with no tokens carries no usage information; recording it would
  // inflate call counts without adding anything measurable.
  if (!tokens.in && !tokens.out && !tokens.cache_read && !tokens.cache_write && !tokens.unattributed) {
    return { written: false, event: null, reason: 'no token usage reported' };
  }

  /** @type {UsageEvent} */
  const suppliedModel = input.model ? String(input.model) : null;
  const suppliedObservedModel = input.observed_model != null
    ? String(input.observed_model)
    : input.observedModel != null ? String(input.observedModel) : null;
  const suppliedRequestedModel = input.requested_model != null
    ? String(input.requested_model)
    : input.requestedModel != null ? String(input.requestedModel) : null;
  const unverifiedProviderModel = modelEvidence === 'provider_response' && !modelVerified;
  const requestedOnlyModel = modelEvidence === 'requested_only';
  const event = {
    event_id: '',
    device_id: input.device_id || 'unknown',
    harness: String(input.harness),
    harness_evidence: harnessEvidence,
    harness_verified: harnessVerified,
    provider: input.provider ? String(input.provider) : 'unknown',
    model: unverifiedProviderModel || requestedOnlyModel ? null : suppliedModel,
    observed_model: suppliedObservedModel || (unverifiedProviderModel ? suppliedModel : null),
    requested_model: suppliedRequestedModel || (requestedOnlyModel ? suppliedModel : null),
    model_evidence: modelEvidence,
    model_verified: modelVerified,
    pricing_model: input.pricing_model ? String(input.pricing_model) : null,
    ts: input.ts || new Date().toISOString(),
    tokens,
    source: input.source || 'proxy',
    session_id: input.session_id || null,
    request_id: input.request_id || null
  };
  if (input.duration_ms != null) event.duration_ms = Math.round(Number(input.duration_ms) || 0);
  if (input.status != null) event.status = Number(input.status) || 0;

  event.event_id = input.event_id || deriveEventId(event);

  const day = utcDay(event.ts);
  const seen = loadSeen(day);
  if (seen.has(event.event_id)) return { written: false, event, reason: 'duplicate' };

  seen.add(event.event_id);
  enqueue(day, JSON.stringify(event) + '\n');
  return { written: true, event };
}

// --- write queue -----------------------------------------------------------
// Appends are batched and flushed asynchronously. The proxy calls append() on
// the same event loop that is streaming responses to other harnesses, so a
// synchronous disk write there would stall live traffic on a slow or contended
// disk — directly harming time-to-first-token for unrelated requests.

/** @type {Map<string, string[]>} pending lines keyed by UTC day */
const pending = new Map();
let flushTimer = null;
/** @type {Promise<void>} serialises flushes so lines never interleave */
let flushChain = Promise.resolve();
/** @type {((err: Error) => void)|null} */
let onWriteError = null;

function scheduleFlush() {
  if (flushTimer || !pending.size) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 250);
  if (flushTimer.unref) flushTimer.unref();
}

/** @param {string} day @param {string} line */
function enqueue(day, line) {
  const lines = pending.get(day) || [];
  lines.push(line);
  pending.set(day, lines);
  scheduleFlush();
}

/**
 * Write everything queued so far.
 * @returns {Promise<void>} resolves once the queue at call time is on disk
 */
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = new Map(pending);
  pending.clear();
  if (!batch.size) return flushChain;

  flushChain = flushChain.then(() => new Promise((resolve) => {
    const days = [...batch.entries()];
    let index = 0;
    const next = () => {
      if (index >= days.length) return resolve();
      const [day, lines] = days[index++];
      try { ensureDir(eventsDir()); } catch (_) { /* handled by the append error */ }
      fs.appendFile(dayFile(day), lines.join(''), 'utf8', (err) => {
        if (err) {
          // Re-queue so a transient failure (disk full, lock) is retried.
          const back = pending.get(day) || [];
          pending.set(day, lines.concat(back));
          scheduleFlush();
          if (onWriteError) { try { onWriteError(err); } catch (_) { /* ignore */ } }
        }
        next();
      });
    };
    next();
  }));
  return flushChain;
}

/** @param {(err: Error) => void} handler notified when a flush fails */
function onError(handler) { onWriteError = handler; }

/**
 * Read events within an inclusive range of UTC days.
 *
 * @param {object} [range]
 * @param {string} [range.from] YYYY-MM-DD, defaults to 30 days ago
 * @param {string} [range.to]   YYYY-MM-DD, defaults to today
 * @returns {UsageEvent[]}
 */
function read(range) {
  const opts = range || {};
  const to = opts.to || utcDay(Date.now());
  const from = opts.from || utcDay(Date.now() - 30 * 24 * 3600 * 1000);

  /** @type {UsageEvent[]} */
  const out = [];
  let files = [];
  try { files = fs.readdirSync(eventsDir()); } catch (_) { return out; }

  // Deduplicate on read as well as on write. Writes are guarded per process,
  // but several processes (or a collector merging files from other devices)
  // can put the same event_id on disk twice — and a duplicate that reaches
  // rollup becomes double-counted tokens, the exact failure this store exists
  // to prevent.
  const seen = new Set();
  for (const name of files.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const day = name.slice(0, -6);
    if (day < from || day > to) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(eventsDir(), name), 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed) continue;
        if (parsed.event_id) {
          if (seen.has(parsed.event_id)) continue;
          seen.add(parsed.event_id);
        }
        out.push(parsed);
      } catch (_) { /* skip torn line */ }
    }
  }
  return out;
}

/**
 * Aggregate events into per-(local day, harness, model) buckets.
 *
 * Buckets use the *local* calendar day so the dashboard matches what the user
 * experienced, while storage stays in UTC.
 *
 * @param {UsageEvent[]} events
 * @returns {Record<string, Record<string, Record<string, {tokens:object, calls:number, provider:string}>>>}
 *          day -> harness -> model -> totals
 */
function rollup(events) {
  const days = {};
  for (const ev of events || []) {
    const d = new Date(ev.ts);
    if (isNaN(d.getTime())) continue;
    const localDay = d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');

    const harnesses = days[localDay] || (days[localDay] = {});
    const models = harnesses[ev.harness] || (harnesses[ev.harness] = {});
    const key = ev.model || 'unknown';
    const bucket = models[key] || (models[key] = {
      tokens: {
        in: 0, out: 0, cache_read: 0, cache_write: 0,
        cache_write_5m: 0, cache_write_1h: 0, cache_write_unresolved: 0,
        reasoning: 0, unattributed: 0
      },
      calls: 0,
      provider: ev.provider || 'unknown'
    });

    const t = normalizeTokens(ev.tokens);
    bucket.tokens.in += t.in;
    bucket.tokens.out += t.out;
    bucket.tokens.cache_read += t.cache_read;
    bucket.tokens.cache_write += t.cache_write;
    bucket.tokens.cache_write_5m += t.cache_write_5m;
    bucket.tokens.cache_write_1h += t.cache_write_1h;
    bucket.tokens.cache_write_unresolved += t.cache_write_unresolved;
    bucket.tokens.reasoning += t.reasoning;
    bucket.tokens.unattributed += t.unattributed;
    bucket.calls += 1;
  }
  return days;
}

/**
 * Remove event files older than the retention window.
 * @param {number} [retentionDays=400]
 * @returns {number} files deleted
 */
function prune(retentionDays) {
  const keep = Number(retentionDays) > 0 ? Number(retentionDays) : 400;
  const cutoff = utcDay(Date.now() - keep * 24 * 3600 * 1000);
  let removed = 0;
  let files = [];
  try { files = fs.readdirSync(eventsDir()); } catch (_) { return 0; }
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    if (name.slice(0, -6) >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(eventsDir(), name));
      seenByDay.delete(name.slice(0, -6));
      removed++;
    } catch (_) { /* leave it for the next run */ }
  }
  return removed;
}

module.exports = {
  append, flush, onError, read, rollup, prune,
  deriveEventId, normalizeTokens, utcDay, eventsDir,
  HARNESS_EVIDENCE, MODEL_EVIDENCE
};
