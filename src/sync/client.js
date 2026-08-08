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
const crypto = require('crypto');
const MAX_RESPONSE_BYTES = 1024 * 1024;

const outbox = require('./outbox');
const { identity } = require('../core/device');

/**
 * Shown when the collector refuses this device's credential. Device
 * credentials expire, so the ordinary cause is a link that has simply run out
 * rather than anything the customer did wrong.
 */
const RELINK_MESSAGE = 'This computer is no longer linked to Super ZT. '
  + 'Create a new link code at super-zt.com/portal/usage-panel and link it again — '
  + 'usage already recorded on this PC is kept and will be sent once linking succeeds.';

/**
 * Collector refusal reasons that can stop being true, so the events must be
 * offered again rather than thrown away. A device clock a few minutes fast has
 * every event refused; the same events are valid once the clock is corrected.
 */
const RETRYABLE_REJECTION_REASONS = new Set(['timestamp_out_of_range']);

/**
 * Identify a credential without keeping a copy of it, so the cursor can tell
 * "still the credential that was refused" from "the device has been linked
 * again" without ever storing the secret.
 * @param {string} credential
 * @returns {string}
 */
function credentialFingerprint(credential) {
  return crypto.createHash('sha256').update(String(credential)).digest('hex').slice(0, 16);
}

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

/**
 * How much of the optional contract this collector has been shown to accept.
 *
 * The portal request schema is strict, so a collector that predates a field
 * rejects the whole batch rather than ignoring the extra key. The device and
 * the website are separate deployments and either can be older, so the client
 * negotiates instead of assuming: it offers the richest payload, and steps down
 * once if the collector refuses the shape. That turns a deployment-order
 * dependency into something that heals itself in either direction.
 */
const CONTRACT_TIERS = ['full', 'pricing', 'base'];

/** @param {string} tier @returns {string} the next narrower tier */
function narrowerTier(tier) {
  const index = CONTRACT_TIERS.indexOf(tier);
  return CONTRACT_TIERS[Math.min(index + 1, CONTRACT_TIERS.length - 1)];
}

/**
 * Evidence recorded with the event, defaulted honestly.
 *
 * An event written before evidence existed carries none, and the only safe
 * answer for it is `unknown` — deriving a class from other fields would be this
 * client inventing a provenance nobody recorded. Nothing here ever raises a
 * claim: `model_verified` is passed through exactly as stored, and the model
 * string is whatever the store holds, which is already null for a model the
 * store judged unverified.
 *
 * @param {object} event
 * @returns {{harnessEvidence:string, harnessVerified:boolean, modelEvidence:string, modelVerified:boolean}}
 */
function evidenceOf(event) {
  return {
    harnessEvidence: typeof event.harness_evidence === 'string' ? event.harness_evidence : 'unknown',
    harnessVerified: event.harness_verified === true,
    modelEvidence: typeof event.model_evidence === 'string' ? event.model_evidence : 'unknown',
    modelVerified: event.model_verified === true
  };
}

/**
 * Translate a local usage fact to the strict Super ZT portal event contract.
 * @param {object} event
 * @param {string} [tier='full'] how much of the optional contract to include
 */
function portalEvent(event, tier) {
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

  const wire = {
    eventId: event.event_id,
    harness: event.harness,
    provider: event.provider,
    // Passed through as stored. The store already writes null here for a model
    // it judged unverified, and this must not put the observed string back.
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

  const level = tier || 'full';
  if (level === 'base') return wire;

  // The catalogue id for a model string that is not itself priceable
  // (codex-auto-review -> gpt-5.6-sol). Without it the portal cannot price
  // those events and disagrees with the panel on the same usage.
  wire.pricingModel = event.pricing_model != null ? event.pricing_model : null;
  if (level === 'pricing') return wire;

  return Object.assign(wire, evidenceOf(event));
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

  // A credential the collector has already refused is not sent again until its
  // retry time. Without this the panel repeats a dead credential on every tick
  // for as long as the PC is switched on, and never says why nothing arrives.
  const fingerprint = credentialFingerprint(credential);
  const link = outbox.linkState(fingerprint);
  if (link.relinkRequired && !link.mayRetry) {
    const waiting = outbox.pending({ limit: 1e9, lookbackDays: config.lookbackDays || 45 });
    return {
      ok: false,
      sent: 0,
      pending: waiting.pendingTotal + waiting.waitingTotal,
      relinkRequired: true,
      nextAttemptAt: link.retryAfter,
      message: link.message || RELINK_MESSAGE
    };
  }

  outbox.pruneDeferred(config.lookbackDays || 45);
  const { batch, pendingTotal, waitingTotal } = outbox.pending({
    limit: usesPortalContract(url) ? Math.min(config.batchSize || 200, 200) : (config.batchSize || 500),
    lookbackDays: config.lookbackDays || 45
  });
  if (!batch.length) return { ok: true, sent: 0, pending: 0, waiting: waitingTotal };

  const localDevice = identity(config.deviceLabel);
  const device = {
    id: config.deviceId || localDevice.id,
    label: localDevice.label,
    platform: localDevice.platform
  };
  const standaloneEvents = batch.map((event) => ({
    event_id: event.event_id,
    harness: event.harness,
    harness_evidence: event.harness_evidence,
    harness_verified: event.harness_verified === true,
    provider: event.provider,
    model: event.model,
    model_evidence: event.model_evidence,
    model_verified: event.model_verified === true,
    pricing_model: event.pricing_model,
    ts: event.ts,
    tokens: event.tokens,
    source: event.source,
    duration_ms: event.duration_ms,
    status: event.status
  }));
  const portalContract = usesPortalContract(url);

  let response;
  let tier = outbox.contractTier();
  try {
    for (;;) {
      const body = portalContract
        ? { events: batch.map((event) => portalEvent(event, tier)) }
        : { device: { id: device.id, label: device.label, platform: device.platform }, events: standaloneEvents };
      response = await postJSON(url, body, credential, config.timeoutMs);
      // A strict collector refuses an unknown key by rejecting the batch. The
      // retry is itself the discriminator: if a narrower payload is accepted the
      // extra fields were the problem, and if it is refused too the batch is
      // genuinely bad and falls through to the normal error path below.
      if (!portalContract || response.status !== 400 || tier === 'base') break;
      tier = narrowerTier(tier);
      outbox.setContractTier(tier);
    }
  } catch (err) {
    outbox.markError(err.message);
    return { ok: false, sent: 0, pending: pendingTotal, message: err.message };
  }

  if (response.status === 401 || response.status === 403) {
    // Authoritative: the collector looked at this credential and refused it.
    // Record which credential, so re-linking clears the state by itself.
    outbox.markCredentialRejected(fingerprint, RELINK_MESSAGE);
    const state = outbox.linkState(fingerprint);
    return {
      ok: false,
      sent: 0,
      pending: pendingTotal + waitingTotal,
      relinkRequired: true,
      nextAttemptAt: state.retryAfter,
      message: RELINK_MESSAGE
    };
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
  // Keep each refusal's reason attached to its id: a refusal the device can
  // grow out of must be retried, and one it cannot must not be.
  /** @type {Array<{eventId:string, reason:string}>} */
  const refusals = outcomes
    ? outcomes.filter((entry) => entry && entry.status === 'rejected')
      .map((entry) => ({ eventId: entry.eventId, reason: entry.reason ? String(entry.reason) : 'unknown' }))
    : response.json && Array.isArray(response.json.permanentlyRejected)
      ? response.json.permanentlyRejected
        .map((entry) => {
          if (typeof entry === 'string') return { eventId: entry, reason: 'unknown' };
          if (!entry || typeof entry !== 'object') return null;
          const reason = entry.reason ? String(entry.reason) : 'unknown';
          if (entry.event_id) return { eventId: entry.event_id, reason };
          const index = Number(entry.event_index);
          return Number.isInteger(index) && index >= 0 && index < batch.length
            ? { eventId: batch[index].event_id, reason } : null;
        })
        .filter(Boolean)
      : [];

  const seenRefusal = new Set();
  const permanent = [];
  const deferrable = [];
  for (const refusal of refusals) {
    if (!batchIds.has(refusal.eventId) || acceptedSet.has(refusal.eventId)) continue;
    if (seenRefusal.has(refusal.eventId)) continue;
    seenRefusal.add(refusal.eventId);
    if (RETRYABLE_REJECTION_REASONS.has(refusal.reason)) deferrable.push(refusal);
    else permanent.push(refusal.eventId);
  }

  outbox.markSent(acceptedIds);
  // A delivery on this credential proves the link is alive again.
  if (acceptedIds.length) outbox.clearCredentialRejection();
  const held = outbox.markDeferred(deferrable);
  outbox.markRejected(permanent);
  const rejectedCount = permanent.length + held.exhausted.length;
  return {
    ok: true,
    sent: acceptedIds.length,
    rejected: rejectedCount,
    deferred: held.deferred.length,
    pending: Math.max(0, pendingTotal - acceptedIds.length - rejectedCount - held.deferred.length),
    waiting: waitingTotal + held.deferred.length
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
  let deferred = 0;
  let last = { ok: true, sent: 0, pending: 0 };
  for (let i = 0; i < cap; i++) {
    last = await pushOnce(config);
    sent += last.sent;
    rejected += last.rejected || 0;
    deferred += last.deferred || 0;
    // A refused credential stops the drain immediately: every remaining batch
    // would be refused the same way.
    if (!last.ok || (last.sent === 0 && !last.rejected)) break;
  }
  // The published result shape is unchanged for an ordinary push; the extra
  // fields appear only when there is something new to report, so existing
  // callers that compare the whole object still see exactly what they expect.
  const result = { ok: last.ok, sent, rejected, pending: last.pending, message: last.message };
  if (deferred) result.deferred = deferred;
  if (last.relinkRequired) {
    result.relinkRequired = true;
    result.nextAttemptAt = last.nextAttemptAt || null;
  }
  return result;
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
