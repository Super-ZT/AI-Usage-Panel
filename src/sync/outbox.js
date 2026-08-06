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
 * @typedef {object} Cursor
 * @property {string[]} sent        ids acknowledged by the collector (recent window)
 * @property {string[]} rejected    ids permanently rejected by the collector
 * @property {string|null} lastSyncAt
 * @property {string|null} lastError
 * @property {number} sentTotal
 * @property {number} rejectedTotal
 */

/** @returns {Cursor} */
function loadCursor() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath(), 'utf8'));
    return {
      sent: Array.isArray(parsed.sent) ? parsed.sent : [],
      rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
      lastSyncAt: parsed.lastSyncAt || null,
      lastError: parsed.lastError || null,
      sentTotal: Number(parsed.sentTotal) || 0,
      rejectedTotal: Number(parsed.rejectedTotal) || 0
    };
  } catch (_) {
    return { sent: [], rejected: [], lastSyncAt: null, lastError: null, sentTotal: 0, rejectedTotal: 0 };
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
 * @param {object} [options]
 * @param {number} [options.limit=500] maximum events per batch
 * @param {number} [options.lookbackDays=45] how far back to consider
 * @returns {{batch: object[], pendingTotal: number}}
 */
function pending(options) {
  const opts = options || {};
  const limit = opts.limit || 500;
  const lookback = opts.lookbackDays || 45;

  const cursor = loadCursor();
  const sent = new Set(cursor.sent);
  const rejected = new Set(cursor.rejected);
  const from = events.utcDay(Date.now() - lookback * 24 * 3600 * 1000);
  const all = events.read({ from });

  const unsent = all.filter((e) => e.event_id && !sent.has(e.event_id) && !rejected.has(e.event_id));
  return { batch: unsent.slice(0, limit), pendingTotal: unsent.length };
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
  const merged = cursor.rejected.concat(ids);
  const cap = keep || 20000;
  cursor.rejected = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  cursor.rejectedTotal += ids.length;
  cursor.lastSyncAt = new Date().toISOString();
  cursor.lastError = ids.length + ' event' + (ids.length === 1 ? '' : 's') + ' permanently rejected';
  saveCursor(cursor);
}

/** @param {string} message */
function markError(message) {
  const cursor = loadCursor();
  cursor.lastError = String(message || 'unknown error');
  saveCursor(cursor);
}

/** @returns {{lastSyncAt:string|null,lastError:string|null,sentTotal:number,rejectedTotal:number,pendingTotal:number}} */
function status() {
  const cursor = loadCursor();
  let pendingTotal = 0;
  try { pendingTotal = pending({ limit: 1e9 }).pendingTotal; } catch (_) { /* store unreadable */ }
  return {
    lastSyncAt: cursor.lastSyncAt,
    lastError: cursor.lastError,
    sentTotal: cursor.sentTotal,
    rejectedTotal: cursor.rejectedTotal,
    pendingTotal
  };
}

module.exports = { pending, markSent, markRejected, markError, status, loadCursor, saveCursor };
