'use strict';

/**
 * Sync client — ships usage events from this device to a central collector.
 *
 * Security posture:
 *   - HTTPS is required unless the endpoint is explicitly loopback/private and
 *     the operator opts in, so a device credential is never sent over plaintext to
 *     the public internet.
 *   - Only an explicit allowlist of usage fields leaves the device. API keys,
 *     prompts, completions, file paths and raw provider session/request ids are
 *     never transmitted.
 *   - The upload-only device credential is sent as a bearer token and never logged.
 *
 * Delivery is at-least-once: batches are retried until acknowledged, and the
 * collector deduplicates by event id.
 */

const http = require('http');
const https = require('https');

const outbox = require('./outbox');
const { identity } = require('../core/device');

/** Hosts for which plaintext HTTP is tolerated without an explicit override. */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

/**
 * @param {string} endpoint
 * @param {boolean} allowInsecure
 * @returns {URL}
 */
function validateEndpoint(endpoint, allowInsecure) {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') throw new Error('endpoint must be http(s)');
  if (PRIVATE_HOST.test(url.hostname) || allowInsecure) return url;
  throw new Error('refusing to send a device credential over plaintext HTTP to ' + url.hostname
    + ' — use https, or set sync.allowInsecure to override for a trusted network');
}

/**
 * POST JSON with a timeout.
 *
 * @param {URL} url
 * @param {object} body
 * @param {string} token
 * @param {number} timeoutMs
 * @returns {Promise<{status:number, json:any, raw:string}>}
 */
function postJSON(url, body, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = url.protocol === 'https:' ? https : http;
    const headers = {
      'content-type': 'application/json',
      'content-length': payload.length,
      'user-agent': 'usage-panel-sync'
    };
    if (token) headers.authorization = 'Bearer ' + token;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: timeoutMs || 20000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* non-JSON response */ }
        resolve({ status: res.statusCode || 0, json, raw: raw.slice(0, 500) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('collector timed out')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Push one batch of pending events.
 *
 * @param {object} config sync configuration
 * @param {string} config.endpoint  e.g. https://vps.example.com
 * @param {string} config.deviceCredential unique upload-only device credential
 * @param {boolean} [config.allowInsecure]
 * @param {number} [config.batchSize]
 * @param {string} [config.deviceLabel]
 * @returns {Promise<{ok:boolean, sent:number, rejected?:number, pending:number, message?:string}>}
 */
async function pushOnce(config) {
  const credential = config && config.deviceCredential;
  if (!config || !config.endpoint || !credential) {
    return { ok: false, sent: 0, pending: 0, message: 'sync not configured' };
  }

  let url;
  try {
    url = validateEndpoint(config.endpoint.replace(/\/$/, '') + '/api/v1/events', !!config.allowInsecure);
  } catch (err) {
    outbox.markError(err.message);
    return { ok: false, sent: 0, pending: 0, message: err.message };
  }

  const { batch, pendingTotal } = outbox.pending({
    limit: config.batchSize || 500,
    lookbackDays: config.lookbackDays || 45
  });
  if (!batch.length) return { ok: true, sent: 0, pending: 0 };

  const localDevice = identity(config.deviceLabel);
  const device = {
    id: config.deviceId || localDevice.id,
    label: localDevice.label,
    platform: localDevice.platform
  };
  const outboundEvents = batch.map((event) => ({
    event_id: event.event_id,
    harness: event.harness,
    provider: event.provider,
    model: event.model,
    pricing_model: event.pricing_model,
    ts: event.ts,
    tokens: event.tokens,
    source: event.source,
    duration_ms: event.duration_ms,
    status: event.status
  }));
  let response;
  try {
    response = await postJSON(url, {
      device: { id: device.id, label: device.label, platform: device.platform },
      events: outboundEvents
    }, credential, config.timeoutMs);
  } catch (err) {
    outbox.markError(err.message);
    return { ok: false, sent: 0, pending: pendingTotal, message: err.message };
  }

  if (response.status === 401 || response.status === 403) {
    const message = 'collector rejected the device credential';
    outbox.markError(message);
    return { ok: false, sent: 0, pending: pendingTotal, message };
  }
  if (response.status < 200 || response.status >= 300) {
    const message = 'collector returned HTTP ' + response.status;
    outbox.markError(message);
    return { ok: false, sent: 0, pending: pendingTotal, message };
  }

  // Trust the collector's own list of accepted ids when it supplies one, so a
  // partial acceptance does not mark unsent events as delivered.
  const batchIds = new Set(batch.map((event) => event.event_id));
  const acceptedIds = [...new Set((response.json && Array.isArray(response.json.accepted)
    ? response.json.accepted
    : batch.map((e) => e.event_id))
    .filter((id) => batchIds.has(id)))];
  const acceptedSet = new Set(acceptedIds);
  const rejectedIds = [...new Set((response.json && Array.isArray(response.json.permanentlyRejected)
    ? response.json.permanentlyRejected
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object') return null;
        if (entry.event_id) return entry.event_id;
        const index = Number(entry.event_index);
        return Number.isInteger(index) && index >= 0 && index < batch.length
          ? batch[index].event_id : null;
      })
      .filter(Boolean)
    : [])
    .filter((id) => batchIds.has(id) && !acceptedSet.has(id)))];

  outbox.markSent(acceptedIds);
  outbox.markRejected(rejectedIds);
  return {
    ok: true,
    sent: acceptedIds.length,
    rejected: rejectedIds.length,
    pending: Math.max(0, pendingTotal - acceptedIds.length - rejectedIds.length)
  };
}

/**
 * Drain the outbox, one batch at a time.
 * @param {object} config
 * @param {number} [maxBatches=20]
 * @returns {Promise<{ok:boolean, sent:number, rejected?:number, pending:number, message?:string}>}
 */
async function push(config, maxBatches) {
  const cap = maxBatches || 20;
  let sent = 0;
  let rejected = 0;
  let last = { ok: true, sent: 0, pending: 0 };
  for (let i = 0; i < cap; i++) {
    last = await pushOnce(config);
    sent += last.sent;
    rejected += last.rejected || 0;
    if (!last.ok || (last.sent === 0 && !last.rejected)) break;
  }
  return { ok: last.ok, sent, rejected, pending: last.pending, message: last.message };
}

/**
 * Fetch the fleet-wide view from the collector (the "and back" direction).
 *
 * @param {object} config
 * @returns {Promise<{ok:boolean, data:any, message?:string}>}
 */
async function fetchFleet(config) {
  const session = config && config.managerSession;
  if (!config || !config.endpoint || !session) {
    return { ok: false, data: null, message: 'sync not configured' };
  }
  let url;
  try {
    url = validateEndpoint(config.endpoint.replace(/\/$/, '') + '/api/v1/fleet', !!config.allowInsecure);
  } catch (err) {
    return { ok: false, data: null, message: err.message };
  }

  return new Promise((resolve) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: { authorization: 'Bearer ' + session, 'user-agent': 'usage-panel-sync' },
      timeout: config.timeoutMs || 20000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, data: null, message: 'HTTP ' + res.statusCode });
        try { resolve({ ok: true, data: JSON.parse(raw) }); }
        catch (_) { resolve({ ok: false, data: null, message: 'invalid response' }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, data: null, message: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, message: 'timed out' }); });
    req.end();
  });
}

/** Enroll this installation with a short-lived, one-use company code. */
async function enroll(config) {
  if (!config || !config.endpoint || !config.code) throw new Error('endpoint and enrollment code are required');
  const url = validateEndpoint(config.endpoint.replace(/\/$/, '') + '/api/v1/enroll', !!config.allowInsecure);
  const response = await postJSON(url, {
    code: config.code,
    label: config.label || identity().label,
    platform: config.platform || identity().platform
  }, null, config.timeoutMs);
  if (response.status !== 201 || !response.json || !response.json.deviceCredential) {
    throw new Error(response.status === 401 ? 'invalid or expired enrollment code' : 'enrollment failed');
  }
  return response.json;
}

module.exports = { push, pushOnce, fetchFleet, enroll, validateEndpoint };
