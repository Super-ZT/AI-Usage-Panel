'use strict';

/**
 * Agent Zero adapter.
 *
 * Agent Zero is unusual among the supported harnesses: the `a0` command is only
 * a terminal client for an Agent Zero *server* (default http://localhost:5080,
 * overridable with AGENT_ZERO_HOST). Nothing useful is written to disk locally,
 * so usage has to be read from that server's own API.
 *
 * The instance is normally unauthenticated on loopback; when it is protected,
 * a token can be supplied via config (`agentZero.token`) or the AGENT_ZERO_TOKEN
 * environment variable.
 */

const http = require('http');
const https = require('https');
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * GET JSON from the Agent Zero instance.
 * @param {string} base base URL, e.g. http://localhost:5080
 * @param {string} pathname
 * @param {string|null} token
 * @param {number} timeoutMs
 * @returns {Promise<{status:number, json:any}>}
 */
function getJSON(base, pathname, token, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let url;
    try { url = new URL(pathname, base); } catch (_) { return finish({ status: 0, json: null }); }
    const transport = url.protocol === 'https:' ? https : http;
    /** @type {Record<string,string>} */
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout: timeoutMs || 4000
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) return res.destroy(new Error('response too large'));
        chunks.push(c);
      });
      res.on('error', () => finish({ status: 0, json: null }));
      res.on('aborted', () => finish({ status: 0, json: null }));
      res.on('close', () => { if (!res.complete) finish({ status: 0, json: null }); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* not JSON */ }
        finish({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', () => finish({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, json: null }); });
    req.end();
  });
}

/**
 * Pull the first numeric value found at any of the given dotted paths.
 * Agent Zero's API surface varies by version, so probe rather than assume.
 *
 * @param {any} obj
 * @param {string[]} paths
 * @returns {number|null}
 */
function pickNumber(obj, paths) {
  for (const p of paths) {
    let node = obj;
    let ok = true;
    for (const key of p.split('.')) {
      if (node && typeof node === 'object' && key in node) node = node[key];
      else { ok = false; break; }
    }
    if (ok) {
      if (!['number', 'string'].includes(typeof node)) continue;
      if (typeof node === 'string' && !node.trim()) continue;
      const n = Number(node);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

module.exports = {
  id: 'agent-zero',
  label: 'Agent Zero',

  /**
   * Agent Zero has no subscription of its own — it uses whatever provider keys
   * the instance is configured with — so there is no quota to report. Its usage
   * shows up through the capture proxy if the *server* is pointed at it.
   */
  quota: null,

  /**
   * Query the running instance for token usage.
   *
   * @param {object} ctx
   * @returns {Promise<object|null>}
   */
  async tokens(ctx) {
    const cfg = (ctx && ctx.config) || {};
    if (cfg.enabled === false) return null;

    const base = cfg.host
      || process.env.AGENT_ZERO_HOST
      || 'http://localhost:5080';
    const token = cfg.token || process.env.AGENT_ZERO_TOKEN || null;

    // Probe the endpoints known across Agent Zero versions; the first that
    // answers with JSON wins.
    const candidates = ['/api/usage', '/usage', '/api/stats', '/api/health'];
    for (const pathname of candidates) {
      const res = await getJSON(base, pathname, token, cfg.timeoutMs);
      if (res.status !== 200 || !res.json) continue;

      const input = pickNumber(res.json, [
        'tokens.input', 'usage.input_tokens', 'total_tokens.input', 'input_tokens'
      ]);
      const output = pickNumber(res.json, [
        'tokens.output', 'usage.output_tokens', 'total_tokens.output', 'output_tokens'
      ]);
      if (input == null && output == null) continue;

      return {
        status: 'ok',
        source: 'server-api',
        endpoint: base,
        tokens: { in: input || 0, out: output || 0, cache_read: 0, cache_write: 0, reasoning: 0 }
      };
    }

    // Reachable but without a usage endpoint, or not running at all — say which,
    // rather than reporting zero usage as though it were measured.
    const health = await getJSON(base, '/api/health', token, cfg.timeoutMs);
    return {
      status: health.status === 200 ? 'no-usage-endpoint' : 'unreachable',
      source: 'server-api',
      endpoint: base,
      note: health.status === 200
        ? 'instance reachable but exposes no usage endpoint — route it through the capture proxy instead'
        : 'no Agent Zero instance reachable at ' + base
    };
  }
};
