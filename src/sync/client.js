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
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
  if (url.search || url.hash) throw new Error('endpoint must not include a query string or fragment');
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') throw new Error('endpoint must be http(s)');
  if (PRIVATE_HOST.test(url.hostname) || allowInsecure) return url;
  throw new Error('refusing to send a device credential over plaintext HTTP to ' + url.hostname
    + ' — use https, or set sync.allowInsecure to override for a trusted network');
}

/** Build a collector route while preserving the standalone server's API path. */
function collectorUrl(endpoint, resource, allowInsecure) {
  if (!/^[a-z][a-z0-9-]*$/.test(resource)) throw new Error('invalid collector resource');
  const url = validateEndpoint(endpoint, allowInsecure);
  const basePath = url.pathname.replace(/\/+$/, '');
  const apiPath = basePath ? '/v1/' : '/api/v1/';
  url.pathname = basePath + apiPath + resource;
  return url;
}

/** Whether a collector URL uses the Super ZT portal's mounted public contract. */
function usesPortalContract(url) {
  return /(?:^|\/)api\/usage-panel\/v1\//.test(url.pathname);
}

/** Translate Node platform names to the collector's public device contract. */
function collectorPlatform(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

/** Translate a local usage fact to the strict Super ZT portal event contract. */
function portalEvent(event) {
  const tokens = event.tokens || {};
  const totalWrite = Math.max(0, Number(tokens.cache_write) || 0);
  let fiveMinute = Math.max(0, Number(tokens.cache_write_5m) || 0);
  let oneHour = Math.max(0, Number(tokens.cache_write_1h) || 0);
  let unresolved = Math.max(0, Number(tokens.cache_write_unresolved) || 0);

  fiveMinute = Math.min(fiveMinute, totalWrite);
  oneHour = Math.min(oneHour, Math.max(0, totalWrite - fiveMinute));
  const residual = Math.max(0, totalWrite - fiveMinute - oneHour);
  if (!fiveMinute && !oneHour && !unresolved) fiveMinute = totalWrite;
  else unresolved = Math.max(unresolved, residual);

  return {
    eventId: event.event_id,
    harness: event.harness,
    provider: event.provider,
    model: event.model,
    source: event.source,
    inputTokens: Math.max(0, Number(tokens.in) || 0),
    outputTokens: Math.max(0, Number(tokens.out) || 0),
    cacheReadTokens: Math.max(0, Number(tokens.cache_read) || 0),
    cacheWrite5mTokens: fiveMinute,
    cacheWrite1hTokens: oneHour,
    cacheWriteUnresolvedTokens: unresolved,
    occurredAt: event.ts
  };
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
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
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
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy(new Error('collector response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (err) => finish(reject, err));
      res.on('aborted', () => finish(reject, new Error('collector response aborted')));
      res.on('close', () => { if (!res.complete) finish(reject, new Error('collector response closed early')); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* non-JSON response */ }
        finish(resolve, { status: res.statusCode || 0, json, raw: raw.slice(0, 500) });
      });
    });
    req.on('error', (err) => finish(reject, err));
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
    url = collectorUrl(config.endpoint, 'events', !!config.allowInsecure);
  } catch (err) {
    outbox.markError(err.message);
    return { ok: false, sent: 0, pending: 0, message: err.message };
  }

  const { batch, pendingTotal } = outbox.pending({
    limit: usesPortalContract(url) ? Math.min(config.batchSize || 200, 200) : (config.batchSize || 500),
    lookbackDays: config.lookbackDays || 45
  });
  if (!batch.length) return { ok: true, sent: 0, pending: 0 };

  const localDevice = identity(config.deviceLabel);
  const device = {
    id: config.deviceId || localDevice.id,
    label: localDevice.label,
    platform: localDevice.platform
  };
  const standaloneEvents = batch.map((event) => ({
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
  const portalContract = usesPortalContract(url);
  const outboundEvents = portalContract ? batch.map(portalEvent) : standaloneEvents;
  let response;
  try {
    const body = portalContract
      ? { events: outboundEvents }
      : { device: { id: device.id, label: device.label, platform: device.platform }, events: outboundEvents };
    response = await postJSON(url, body, credential, config.timeoutMs);
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
  const outcomes = response.json && Array.isArray(response.json.outcomes) ? response.json.outcomes : null;
  if (portalContract && !outcomes) {
    const message = 'collector returned an invalid response';
    outbox.markError(message);
    return { ok: false, sent: 0, pending: pendingTotal, message };
  }
  const acceptedIds = [...new Set((outcomes
    ? outcomes.filter((entry) => entry && (entry.status === 'accepted' || entry.status === 'duplicate'))
      .map((entry) => entry.eventId)
    : response.json && Array.isArray(response.json.accepted)
      ? response.json.accepted
      : batch.map((e) => e.event_id))
    .filter((id) => batchIds.has(id)))];
  const acceptedSet = new Set(acceptedIds);
  const rejectedIds = [...new Set((outcomes
    ? outcomes.filter((entry) => entry && entry.status === 'rejected').map((entry) => entry.eventId)
    : response.json && Array.isArray(response.json.permanentlyRejected)
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
    url = collectorUrl(config.endpoint, 'fleet', !!config.allowInsecure);
  } catch (err) {
    return { ok: false, data: null, message: err.message };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { authorization: 'Bearer ' + session, 'user-agent': 'usage-panel-sync' },
      timeout: config.timeoutMs || 20000
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy(new Error('collector response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (err) => finish({ ok: false, data: null, message: err.message }));
      res.on('aborted', () => finish({ ok: false, data: null, message: 'response aborted' }));
      res.on('close', () => {
        if (!res.complete) finish({ ok: false, data: null, message: 'response closed before completion' });
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return finish({ ok: false, data: null, message: 'HTTP ' + res.statusCode });
        try { finish({ ok: true, data: JSON.parse(raw) }); }
        catch (_) { finish({ ok: false, data: null, message: 'invalid response' }); }
      });
    });
    req.on('error', (err) => finish({ ok: false, data: null, message: err.message }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, data: null, message: 'timed out' }); });
    req.end();
  });
}

/** Enroll this installation with a short-lived, one-use company code. */
async function enroll(config) {
  if (!config || !config.endpoint || !config.code) throw new Error('endpoint and enrollment code are required');
  const url = collectorUrl(config.endpoint, 'enroll', !!config.allowInsecure);
  const response = await postJSON(url, {
    code: config.code,
    label: config.label || identity().label,
    platform: collectorPlatform(config.platform || identity().platform)
  }, null, config.timeoutMs);
  const credential = response.json && (response.json.deviceCredential || response.json.credential);
  if (response.status !== 201 || !response.json || !credential || !response.json.deviceId) {
    throw new Error(response.status === 401 || response.status === 404
      ? 'invalid or expired enrollment code'
      : 'enrollment failed (HTTP ' + response.status + ')');
  }
  return Object.assign({}, response.json, { deviceCredential: credential });
}

module.exports = {
  push, pushOnce, fetchFleet, enroll, validateEndpoint, collectorUrl, collectorPlatform,
  usesPortalContract, portalEvent
};
