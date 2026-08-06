'use strict';

/**
 * Capture proxy — transparent recording of LLM API traffic.
 *
 * Harnesses that bring their own key (OpenCode, pi, CodeRabbit, Hermes, …) do
 * not reliably log which model served a request, and reading their config only
 * reveals a *default* rather than what actually ran. Pointing them at this
 * proxy records the truth off the wire: the model in the request, the model the
 * provider reports back, and the token usage in the response.
 *
 * Routing: <proxy>/<harness>/<provider>/<upstream path>
 *   e.g. http://127.0.0.1:8898/opencode/openrouter/v1  ->  openrouter.ai/api/v1
 *
 * Guarantees:
 *   - Requests are forwarded byte-for-byte; capture failures never affect them.
 *   - Credentials are forwarded but never logged, emitted or persisted.
 *   - Streaming responses pass through unbuffered, preserving time-to-first-token.
 */

const http = require('http');
const https = require('https');
const { Transform, pipeline } = require('stream');

const { StreamCapture, usageFromBody, modelFromBody, mergeUsage, ensureUsageReporting } = require('./capture');
const { resolveUpstream } = require('./upstreams');

/** Headers that must never be logged or emitted anywhere. */
const SECRET_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie',
  'proxy-authorization', 'x-goog-api-key', 'openai-organization'
]);

/** Hop-by-hop headers that must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'
]);

/**
 * Request headers dropped before forwarding upstream.
 *
 * `accept-encoding` is removed deliberately: most SDKs (anything on undici)
 * advertise gzip, providers honour it, and the captured copy would then be
 * compressed bytes that fail to parse — silently recording zero usage while
 * the client, which decompresses for itself, sees nothing wrong. Requesting
 * identity encoding upstream keeps capture honest. The response body is still
 * forwarded byte-for-byte.
 */
const DROP_REQUEST_HEADERS = new Set(['accept-encoding']);

/** Reused sockets: avoids a TLS handshake per request. */
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/**
 * Collect header names that must not be forwarded for this specific request.
 * Per RFC 7230 §6.1 any header listed in `Connection:` is hop-by-hop.
 * @param {http.IncomingMessage} req
 * @returns {Set<string>}
 */
function perRequestDrops(req) {
  const drops = new Set();
  const conn = req.headers.connection;
  if (typeof conn === 'string') {
    for (const token of conn.split(',')) {
      const name = token.trim().toLowerCase();
      if (name && name !== 'close' && name !== 'keep-alive') drops.add(name);
    }
  }
  return drops;
}

/**
 * Redact secrets from a header map for safe diagnostics.
 * @param {Record<string,any>} headers
 * @returns {Record<string,string>}
 */
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? '[redacted]' : String(v);
  }
  return out;
}

/**
 * Read a full request body into memory.
 * Request bodies are small (prompts), unlike responses which are streamed.
 * @param {http.IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limitBytes) {
        aborted = true;
        // Drain rather than destroy: tearing down the socket here would stop
        // the 413 from ever reaching the client.
        req.resume();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @typedef {object} ProxyEvent
 * @property {string} harness      route segment identifying the calling tool
 * @property {string} provider     upstream provider key
 * @property {string|null} model   model reported by the provider, else requested
 * @property {string|null} requestedModel
 * @property {{in:number,out:number,cacheRead:number,cacheWrite:number,reasoning:number}|null} usage
 * @property {number} status       upstream HTTP status
 * @property {boolean} streamed
 * @property {number} durationMs
 * @property {string} ts           ISO-8601 UTC
 * @property {string|null} requestId provider request id when supplied
 */

/**
 * Create the capture proxy server.
 *
 * @param {object} [options]
 * @param {(event: ProxyEvent) => void} [options.onEvent] receives one event per completed call
 * @param {Record<string, object>} [options.providers] custom upstream definitions
 * @param {number} [options.maxRequestBytes] request body cap (default 32 MiB)
 * @param {boolean} [options.injectUsageReporting] add stream_options.include_usage
 *        to OpenAI-compatible streaming requests that omit it (default true)
 * @param {(msg: string) => void} [options.log]
 * @returns {http.Server}
 */
function createProxyServer(options) {
  const opts = options || {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const providers = opts.providers || {};
  const maxRequestBytes = opts.maxRequestBytes || 32 * 1024 * 1024;
  const injectUsage = opts.injectUsageReporting !== false;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (res.headersSent) {
        // Never splice an error document onto a body already being delivered.
        res.destroy(err);
        return;
      }
      const status = err && err.statusCode ? err.statusCode : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err && err.message || err), type: 'usage_panel_proxy' } }));
    });
  });

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handleRequest(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] === '__proxy' && segments[1] === 'health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'usage-panel-capture-proxy' }));
      return;
    }

    if (segments.length < 2) {
      throw Object.assign(new Error('path must be /<harness>/<provider>/<upstream path>'), { statusCode: 404 });
    }

    const harness = segments[0];
    const providerKey = segments[1];
    const upstream = resolveUpstream(providerKey, providers);
    if (!upstream) {
      throw Object.assign(new Error('unknown provider: ' + providerKey), { statusCode: 404 });
    }

    const forwardPath = upstream.basePath + '/' + segments.slice(2).join('/') + (url.search || '');

    // --- request ------------------------------------------------------------
    let body = await readBody(req, maxRequestBytes);
    let requestedModel = null;
    let wantsStream = false;
    try {
      if (body.length) {
        const parsed = JSON.parse(body.toString('utf8'));
        requestedModel = modelFromBody(parsed);
        wantsStream = parsed && parsed.stream === true;
      }
    } catch (_) { /* non-JSON body (e.g. multipart): forward untouched */ }

    if (injectUsage && wantsStream) {
      const ensured = ensureUsageReporting(body, upstream.dialect);
      body = ensured.body;
    }

    const extraDrops = perRequestDrops(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase();
      if (HOP_BY_HOP.has(name) || DROP_REQUEST_HEADERS.has(name) || extraDrops.has(name)) continue;
      headers[k] = v;
    }
    headers.host = upstream.port ? upstream.host + ':' + upstream.port : upstream.host;
    if (body.length) headers['content-length'] = String(body.length);

    // --- upstream -----------------------------------------------------------
    const isHttp = upstream.protocol === 'http:';
    const transport = isHttp ? http : https;
    const upstreamReq = transport.request({
      host: upstream.host,
      port: upstream.port || undefined,
      path: forwardPath,
      method: req.method,
      headers,
      agent: isHttp ? httpAgent : httpsAgent,
      timeout: 600000 // long-running completions are normal; the client controls abort
    }, (upstreamRes) => {
      const responseHeaders = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) responseHeaders[k] = v;
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);

      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isStream = contentType.includes('event-stream') || contentType.includes('x-ndjson');
      const capture = new StreamCapture();
      const jsonChunks = [];
      let jsonBytes = 0;

      // Tee the response: forward every chunk untouched while capturing a copy.
      const tee = new Transform({
        transform(chunk, _enc, cb) {
          try {
            if (isStream) {
              capture.push(chunk);
            } else if (jsonBytes < 4 * 1024 * 1024) {
              jsonBytes += chunk.length;
              jsonChunks.push(chunk);
            }
          } catch (_) { /* never let capture break the stream */ }
          cb(null, chunk);
        }
      });

      pipeline(upstreamRes, tee, res, () => {
        let model = null;
        let usage = null;
        try {
          if (isStream) {
            const result = capture.result();
            model = result.model;
            usage = result.usage;
          } else if (jsonChunks.length) {
            const parsed = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
            if (Array.isArray(parsed)) {
              // Gemini's streamGenerateContent without ?alt=sse returns a JSON
              // array of chunks; usage lives on the terminal element.
              for (const frame of parsed) {
                const m = modelFromBody(frame);
                if (m) model = m;
                usage = mergeUsage(usage, usageFromBody(frame));
              }
            } else {
              model = modelFromBody(parsed);
              usage = usageFromBody(parsed);
            }
          }
        } catch (_) { /* unparseable response: emit what we know */ }

        try {
          onEvent({
            harness,
            provider: providerKey,
            // The provider's reported model is authoritative: routers such as
            // OpenRouter resolve aliases to a concrete served model.
            model: model || requestedModel,
            requestedModel,
            usage,
            status: upstreamRes.statusCode || 0,
            streamed: isStream,
            durationMs: Date.now() - startedAt,
            ts: new Date().toISOString(),
            requestId: upstreamRes.headers['x-request-id'] || upstreamRes.headers['request-id'] || null
          });
        } catch (err) {
          log('event sink failed: ' + (err && err.message));
        }
      });
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('upstream timed out'));
    });

    upstreamReq.on('error', (err) => {
      log('upstream error ' + upstream.host + ': ' + err.message);
      if (res.headersSent) {
        // The response body is already in flight; appending a JSON error would
        // corrupt a partially delivered stream. Fail the connection instead.
        res.destroy(err);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream request failed: ' + err.message, type: 'usage_panel_proxy' } }));
    });

    // Abort upstream work if the client disconnects mid-flight.
    res.on('close', () => { if (!res.writableFinished) upstreamReq.destroy(); });

    if (body.length) upstreamReq.write(body);
    upstreamReq.end();
  }

  return server;
}

module.exports = { createProxyServer, redactHeaders, SECRET_HEADERS };
