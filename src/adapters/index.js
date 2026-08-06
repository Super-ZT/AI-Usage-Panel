'use strict';

/**
 * Adapter registry — pluggable per-harness usage collection.
 *
 * An adapter describes how to obtain data for one harness. Registering a new
 * tool means adding a module here and an entry in src/detect/registry.js; no
 * core code changes. Each adapter may implement any subset of:
 *
 *   quota(ctx)   -> Promise<object|null>   subscription limits (official APIs)
 *   tokens(ctx)  -> object|null            token counts from local logs
 *
 * `ctx` provides shared helpers so adapters stay small and testable:
 *   ctx.home        resolved data directory for this harness
 *   ctx.config      this harness's config section
 *   ctx.readLines   line reader for large log files
 *   ctx.walk        recursive file finder
 *   ctx.httpGetJSON authenticated GET helper
 *   ctx.loadJSON    tolerant JSON file reader
 *   ctx.now         timestamp for deterministic tests
 *
 * Adapters must never throw: return null and let the caller show an honest
 * "unavailable" state rather than taking the dashboard down.
 */

/** @typedef {{id:string, label:string, quota?:Function, tokens?:Function}} Adapter */

/** @type {Map<string, Adapter>} */
const adapters = new Map();

/**
 * Register an adapter.
 * @param {Adapter} adapter
 */
function register(adapter) {
  if (!adapter || !adapter.id) throw new Error('adapter requires an id');
  adapters.set(adapter.id, adapter);
}

/** @param {string} id @returns {Adapter|null} */
function get(id) {
  return adapters.get(id) || null;
}

/** @returns {Adapter[]} */
function list() {
  return [...adapters.values()];
}

/**
 * Run an adapter's quota collector, converting any failure into a reported
 * error state rather than an exception.
 *
 * @param {string} id
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
async function collectQuota(id, ctx) {
  const adapter = adapters.get(id);
  if (!adapter || typeof adapter.quota !== 'function') return null;
  try {
    return await adapter.quota(ctx);
  } catch (err) {
    return { status: 'error', label: adapter.label, message: String((err && err.message) || err) };
  }
}

/**
 * Run an adapter's token collector.
 * @param {string} id
 * @param {object} ctx
 * @returns {object|null}
 */
function collectTokens(id, ctx) {
  const adapter = adapters.get(id);
  if (!adapter || typeof adapter.tokens !== 'function') return null;
  try {
    return adapter.tokens(ctx);
  } catch (_) {
    return null;
  }
}

// Built-in adapters. Requiring them here means a new file plus one line makes
// a harness fully supported.
register(require('./agent-zero'));

module.exports = { register, get, list, collectQuota, collectTokens };
