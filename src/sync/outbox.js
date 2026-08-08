'use strict';

/**
 * Outbox — tracks which usage events have reached the central collector.
 *
 * Devices are frequently offline, behind NAT, or shut down mid-send, so the
 * store is the source of truth and the outbox only remembers a high-water
 * mark. Anything not yet acknowledged is resent; because every event carries a
 * stable id, resending is harmless — the collector recognises and ignores
 * duplicates rather than double-counting them.
 */

const fs = require('fs');
const path = require('path');

const { dataDir, ensureDir } = require('../core/paths');
const events = require('../core/events');

/** @returns {string} path to the sync cursor file */
function cursorPath() {
  return path.join(dataDir(), 'sync-cursor.json');
}

/**
 * Retry schedule for an event the collector refused for a reason that can stop
 * being true — today only a device clock outside the accepted window. The first
 * wait is longer than any plausible skew the collector tolerates, so a corrected
 * clock is already past the event's own timestamp by the time we try again.
 */
const DEFER_BACKOFF_MS = [10 * 60 * 1000, 30 * 60 * 1000, 2 * 3600 * 1000, 6 * 3600 * 1000];
/** After this many refusals the reason is treated as permanent after all. */
const MAX_DEFER_ATTEMPTS = 8;

/**
 * Retry schedule after the collector refuses the device credential. A refusal
 * is authoritative, so we stop hammering — but it is never latched forever,
 * because an outage or a misrouted request can produce one too.
 */
const LINK_BACKOFF_MS = [15 * 60 * 1000, 3600 * 1000, 6 * 3600 * 1000];

/** @returns {{status:string,fingerprint:string|null,since:string|null,message:string|null,attempts:number,retryAfter:string|null}} */
function emptyLink() {
  return { status: 'ok', fingerprint: null, since: null, message: null, attempts: 0, retryAfter: null };
}

/**
 * @typedef {object} Cursor
 * @property {string[]} sent        ids acknowledged by the collector (recent window)
 * @property {string[]} rejected    ids permanently rejected by the collector
 * @property {Record<string,{until:string,attempts:number,reason:string}>} deferred
 *   ids the collector refused for a reason that may pass, with the time to retry
 * @property {{status:string,fingerprint:string|null,since:string|null,message:string|null,attempts:number,retryAfter:string|null}} link
 *   whether the device credential is still accepted, and when to try it again
 * @property {string|null} lastSyncAt
 * @property {string|null} lastError
 * @property {number} sentTotal
 * @property {number} rejectedTotal
 * @property {number} deferredTotal
 */

/** @param {any} value @returns {Record<string,{until:string,attempts:number,reason:string}>} */
function normalizeDeferred(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string,{until:string,attempts:number,reason:string}>} */
  const out = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object') continue;
    const until = Date.parse(entry.until);
    if (!Number.isFinite(until)) continue;
    out[id] = {
      until: new Date(until).toISOString(),
      attempts: Number(entry.attempts) > 0 ? Math.round(Number(entry.attempts)) : 1,
      reason: entry.reason ? String(entry.reason) : 'unknown'
    };
  }
  return out;
}

/** @param {any} value @returns {Cursor['link']} */
function normalizeLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyLink();
  if (value.status !== 'rejected') return emptyLink();
  return {
    status: 'rejected',
    fingerprint: value.fingerprint ? String(value.fingerprint) : null,
    since: value.since ? String(value.since) : null,
    message: value.message ? String(value.message) : null,
    attempts: Number(value.attempts) > 0 ? Math.round(Number(value.attempts)) : 1,
    retryAfter: value.retryAfter ? String(value.retryAfter) : null
  };
}

/** @returns {Cursor} */
function loadCursor() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath(), 'utf8'));
    return {
      sent: Array.isArray(parsed.sent) ? parsed.sent : [],
      rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
      // Older cursors predate both fields; an absent value is simply "nothing
      // deferred, link fine", never a reason to discard the rest of the cursor.
      deferred: normalizeDeferred(parsed.deferred),
      link: normalizeLink(parsed.link),
      lastSyncAt: parsed.lastSyncAt || null,
      lastError: parsed.lastError || null,
      sentTotal: Number(parsed.sentTotal) || 0,
      rejectedTotal: Number(parsed.rejectedTotal) || 0,
      deferredTotal: Number(parsed.deferredTotal) || 0
    };
  } catch (_) {
    return {
      sent: [], rejected: [], deferred: {}, link: emptyLink(),
      lastSyncAt: null, lastError: null, sentTotal: 0, rejectedTotal: 0, deferredTotal: 0
    };
  }
}

/**
 * Persist the cursor atomically so a crash mid-write cannot corrupt it.
 * @param {Cursor} cursor
 */
function saveCursor(cursor) {
  try {
    ensureDir(dataDir());
    const file = cursorPath();
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cursor), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) { /* a failed cursor write only means events are resent */ }
}

/**
 * Collect events that have not yet been acknowledged.
 *
 * An event the collector deferred is not pending until its retry time passes;
 * it is still counted in `waitingTotal` so the panel can say "held back" rather
 * than silently reporting nothing to send.
 *
 * @param {object} [options]
 * @param {number} [options.limit=500] maximum events per batch
 * @param {number} [options.lookbackDays=45] how far back to consider
 * @param {number} [options.now=Date.now()]
 * @returns {{batch: object[], pendingTotal: number, waitingTotal: number}}
 */
function pending(options) {
  const opts = options || {};
  const limit = opts.limit || 500;
  const lookback = opts.lookbackDays || 45;
  const now = Number(opts.now) || Date.now();

  const cursor = loadCursor();
  const sent = new Set(cursor.sent);
  const rejected = new Set(cursor.rejected);
  const from = events.utcDay(now - lookback * 24 * 3600 * 1000);
  const all = events.read({ from });

  const unsent = all.filter((e) => e.event_id && !sent.has(e.event_id) && !rejected.has(e.event_id));
  const due = [];
  let waiting = 0;
  for (const event of unsent) {
    const held = cursor.deferred[event.event_id];
    if (held && Date.parse(held.until) > now) waiting++;
    else due.push(event);
  }
  return { batch: due.slice(0, limit), pendingTotal: due.length, waitingTotal: waiting };
}

/**
 * Record that the collector accepted a set of event ids.
 *
 * Only a bounded window of ids is retained: older events fall outside the
 * lookback window anyway, so remembering them forever would grow without limit.
 *
 * @param {string[]} ids
 * @param {number} [keep=20000]
 */
function markSent(ids, keep) {
  if (!ids || !ids.length) return;
  const cursor = loadCursor();
  const merged = cursor.sent.concat(ids);
  const cap = keep || 20000;
  cursor.sent = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  cursor.sentTotal += ids.length;
  // Delivery settles whatever the collector was previously holding back.
  for (const id of ids) delete cursor.deferred[id];
  cursor.lastSyncAt = new Date().toISOString();
  cursor.lastError = null;
  saveCursor(cursor);
}

/**
 * Quarantine ids that the collector says can never be accepted. Keeping them
 * separate from successful deliveries makes the loss visible while preventing
 * one poison event from retrying forever ahead of valid usage.
 * @param {string[]} ids
 * @param {number} [keep=20000]
 */
function markRejected(ids, keep) {
  if (!ids || !ids.length) return;
  const cursor = loadCursor();
  quarantine(cursor, ids, keep);
  cursor.lastSyncAt = new Date().toISOString();
  cursor.lastError = ids.length + ' event' + (ids.length === 1 ? '' : 's') + ' permanently rejected';
  saveCursor(cursor);
}

/**
 * Move ids into the permanent rejection list. Shared by an outright rejection
 * and by a deferred event that has run out of attempts.
 * @param {Cursor} cursor
 * @param {string[]} ids
 * @param {number} [keep=20000]
 */
function quarantine(cursor, ids, keep) {
  const merged = cursor.rejected.concat(ids);
  const cap = keep || 20000;
  cursor.rejected = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  cursor.rejectedTotal += ids.length;
  for (const id of ids) delete cursor.deferred[id];
}

/**
 * Hold back events the collector refused for a reason that can stop being true.
 *
 * The clock-skew case is the one that matters: a PC whose clock is a few
 * minutes fast has every event refused, and quarantining them would destroy
 * that usage for good even after the clock is corrected. Event ids are stable
 * and the collector treats a repeat as a duplicate, so re-offering cannot
 * double-count. An event that keeps being refused eventually becomes permanent
 * so one poison row cannot retry forever.
 *
 * @param {Array<{eventId:string, reason?:string}>} entries
 * @param {number} [now=Date.now()]
 * @returns {{deferred:string[], exhausted:string[]}}
 */
function markDeferred(entries, now) {
  const list = (entries || []).filter((entry) => entry && entry.eventId);
  if (!list.length) return { deferred: [], exhausted: [] };
  const at = Number(now) || Date.now();
  const cursor = loadCursor();
  const deferred = [];
  const exhausted = [];

  for (const entry of list) {
    const previous = cursor.deferred[entry.eventId];
    const attempts = (previous ? previous.attempts : 0) + 1;
    if (attempts > MAX_DEFER_ATTEMPTS) {
      exhausted.push(entry.eventId);
      continue;
    }
    const wait = DEFER_BACKOFF_MS[Math.min(attempts - 1, DEFER_BACKOFF_MS.length - 1)];
    cursor.deferred[entry.eventId] = {
      until: new Date(at + wait).toISOString(),
      attempts,
      reason: entry.reason ? String(entry.reason) : 'unknown'
    };
    deferred.push(entry.eventId);
  }
  if (exhausted.length) quarantine(cursor, exhausted);
  cursor.deferredTotal += deferred.length;
  cursor.lastSyncAt = new Date(at).toISOString();
  cursor.lastError = deferred.length
    ? deferred.length + ' event' + (deferred.length === 1 ? '' : 's')
      + ' held back by the collector — will be sent again automatically'
    : cursor.lastError;
  saveCursor(cursor);
  return { deferred, exhausted };
}

/**
 * Forget deferrals for events that have fallen out of the upload window, so the
 * cursor cannot grow without limit on a device whose clock is never fixed.
 * @param {number} [lookbackDays=45]
 * @param {number} [now=Date.now()]
 * @returns {number} entries removed
 */
function pruneDeferred(lookbackDays, now) {
  const at = Number(now) || Date.now();
  const days = Number(lookbackDays) > 0 ? Number(lookbackDays) : 45;
  const floor = at - days * 24 * 3600 * 1000;
  const cursor = loadCursor();
  let removed = 0;
  for (const [id, entry] of Object.entries(cursor.deferred)) {
    // `until` only ever moves forward from the refusal, so an entry whose retry
    // time is already older than the whole window can never be offered again.
    if (Date.parse(entry.until) < floor) { delete cursor.deferred[id]; removed++; }
  }
  if (removed) saveCursor(cursor);
  return removed;
}

/**
 * Record that the collector refused this device's credential.
 *
 * The refusal is authoritative, so the client stops sending — but it is never
 * latched permanently, because a collector outage or a misrouted request can
 * answer 401 too. Each refusal pushes the next attempt further out, up to six
 * hours, and any successful push clears the state.
 *
 * @param {string} fingerprint identifies the credential without storing it
 * @param {string} message
 * @param {number} [now=Date.now()]
 */
function markCredentialRejected(fingerprint, message, now) {
  const at = Number(now) || Date.now();
  const cursor = loadCursor();
  const same = cursor.link.status === 'rejected' && cursor.link.fingerprint === fingerprint;
  const attempts = same ? cursor.link.attempts + 1 : 1;
  const wait = LINK_BACKOFF_MS[Math.min(attempts - 1, LINK_BACKOFF_MS.length - 1)];
  cursor.link = {
    status: 'rejected',
    fingerprint: fingerprint || null,
    since: same && cursor.link.since ? cursor.link.since : new Date(at).toISOString(),
    message: String(message || 'the collector refused this device credential'),
    attempts,
    retryAfter: new Date(at + wait).toISOString()
  };
  cursor.lastSyncAt = new Date(at).toISOString();
  cursor.lastError = cursor.link.message;
  saveCursor(cursor);
}

/** Forget a credential refusal after a delivery proves the credential works. */
function clearCredentialRejection() {
  const cursor = loadCursor();
  if (cursor.link.status !== 'rejected') return false;
  cursor.link = emptyLink();
  saveCursor(cursor);
  return true;
}

/**
 * Whether this credential may be used right now.
 *
 * A credential the device has never been refused on is always usable. A
 * credential that differs from the refused one is a fresh link, so the refusal
 * no longer applies and is cleared.
 *
 * @param {string} fingerprint
 * @param {number} [now=Date.now()]
 * @returns {{relinkRequired:boolean, mayRetry:boolean, since:string|null, retryAfter:string|null, message:string|null}}
 */
function linkState(fingerprint, now) {
  const at = Number(now) || Date.now();
  const cursor = loadCursor();
  if (cursor.link.status !== 'rejected') {
    return { relinkRequired: false, mayRetry: true, since: null, retryAfter: null, message: null };
  }
  if (cursor.link.fingerprint && fingerprint && cursor.link.fingerprint !== fingerprint) {
    // The device has been linked again since the refusal.
    cursor.link = emptyLink();
    saveCursor(cursor);
    return { relinkRequired: false, mayRetry: true, since: null, retryAfter: null, message: null };
  }
  const retryAfter = Date.parse(cursor.link.retryAfter);
  return {
    relinkRequired: true,
    mayRetry: !Number.isFinite(retryAfter) || retryAfter <= at,
    since: cursor.link.since,
    retryAfter: cursor.link.retryAfter,
    message: cursor.link.message
  };
}

/** @param {string} message */
function markError(message) {
  const cursor = loadCursor();
  cursor.lastError = String(message || 'unknown error');
  saveCursor(cursor);
}

/**
 * @returns {{lastSyncAt:string|null,lastError:string|null,sentTotal:number,
 *   rejectedTotal:number,pendingTotal:number,waitingTotal:number,deferredTotal:number,
 *   relinkRequired:boolean,relinkSince:string|null,nextAttemptAt:string|null}}
 */
function status() {
  const cursor = loadCursor();
  let pendingTotal = 0;
  let waitingTotal = 0;
  try {
    const counts = pending({ limit: 1e9 });
    pendingTotal = counts.pendingTotal;
    waitingTotal = counts.waitingTotal;
  } catch (_) { /* store unreadable */ }
  const relinkRequired = cursor.link.status === 'rejected';
  return {
    lastSyncAt: cursor.lastSyncAt,
    lastError: cursor.lastError,
    sentTotal: cursor.sentTotal,
    rejectedTotal: cursor.rejectedTotal,
    pendingTotal,
    // Held back for a retry, not lost — distinct from `pendingTotal` so a panel
    // can say so, and distinct from `rejectedTotal` which never comes back.
    waitingTotal,
    deferredTotal: cursor.deferredTotal,
    // A device whose link has expired reports this instead of looking idle.
    relinkRequired,
    relinkSince: relinkRequired ? cursor.link.since : null,
    nextAttemptAt: relinkRequired ? cursor.link.retryAfter : null
  };
}

module.exports = {
  pending, markSent, markRejected, markDeferred, pruneDeferred, markError, status,
  markCredentialRejected, clearCredentialRejection, linkState, loadCursor, saveCursor
};
