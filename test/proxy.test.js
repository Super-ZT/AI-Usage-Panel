'use strict';

/**
 * Tests for the capture proxy. No test framework or network access required:
 * dialect parsing is exercised directly, and the end-to-end cases run against a
 * local fake upstream.
 *
 * Run: node test/proxy.test.js
 */

const http = require('http');
const assert = require('assert');

const {
  normalizeUsage, usageFromBody, modelFromBody, StreamCapture, ensureUsageReporting
} = require('../src/proxy/capture');
const { resolveUpstream } = require('../src/proxy/upstreams');
const { createProxyServer, redactHeaders } = require('../src/proxy');

let passed = 0;
const failures = [];

/** @param {string} name @param {() => void|Promise<void>} fn */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n       ' + (err && err.message));
  }
}

// ---------------------------------------------------------------------------
// Dialect normalisation
// ---------------------------------------------------------------------------

async function dialectTests() {
  console.log('\ncapture: usage normalisation');

  await test('OpenAI chat completions splits cached from fresh input', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 }
    });
    assert.strictEqual(u.in, 200, 'fresh input excludes cached');
    assert.strictEqual(u.cacheRead, 800);
    assert.strictEqual(u.out, 50);
  });

  await test('OpenAI responses API reports reasoning tokens', () => {
    const u = normalizeUsage({
      input_tokens: 500,
      output_tokens: 120,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 90 }
    });
    assert.strictEqual(u.in, 400);
    assert.strictEqual(u.cacheRead, 100);
    assert.strictEqual(u.reasoning, 90);
  });

  await test('Anthropic input_tokens already excludes cache reads', () => {
    const u = normalizeUsage({
      input_tokens: 30,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 1200
    });
    assert.strictEqual(u.in, 30, 'must not subtract cache reads for Anthropic');
    assert.strictEqual(u.cacheRead, 5000);
    assert.strictEqual(u.cacheWrite, 1200);
    assert.strictEqual(u.cacheWrite5m, 0);
    assert.strictEqual(u.cacheWrite1h, 0);
  });

  await test('Anthropic cache_creation preserves five-minute and one-hour TTL', () => {
    const u = normalizeUsage({
      input_tokens: 10,
      output_tokens: 58,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 6440,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 6440
      }
    });
    assert.strictEqual(u.cacheWrite, 6440);
    assert.strictEqual(u.cacheWrite5m, 0);
    assert.strictEqual(u.cacheWrite1h, 6440);
  });

  await test('Gemini usageMetadata', () => {
    const u = normalizeUsage({
      promptTokenCount: 900, candidatesTokenCount: 100,
      cachedContentTokenCount: 400, thoughtsTokenCount: 60
    });
    assert.strictEqual(u.in, 500);
    assert.strictEqual(u.cacheRead, 400);
    assert.strictEqual(u.reasoning, 60);
  });

  await test('unknown shapes return null rather than zeros', () => {
    assert.strictEqual(normalizeUsage({ foo: 1 }), null);
    assert.strictEqual(normalizeUsage(null), null);
  });

  await test('model is read from nested payload shapes', () => {
    assert.strictEqual(modelFromBody({ model: 'a' }), 'a');
    assert.strictEqual(modelFromBody({ response: { model: 'b' } }), 'b');
    assert.strictEqual(modelFromBody({ message: { model: 'c' } }), 'c');
    assert.strictEqual(modelFromBody({ modelVersion: 'd' }), 'd');
    assert.strictEqual(modelFromBody({}), null);
  });
}

// ---------------------------------------------------------------------------
// Streaming capture
// ---------------------------------------------------------------------------

async function streamTests() {
  console.log('\ncapture: streaming');

  await test('OpenAI SSE final chunk carries usage', () => {
    const c = new StreamCapture();
    c.push('data: {"model":"gpt-5.6-sol","choices":[{"delta":{"content":"hi"}}]}\n\n');
    c.push('data: {"model":"gpt-5.6-sol","choices":[],"usage":{"prompt_tokens":700,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":600}}}\n\n');
    c.push('data: [DONE]\n\n');
    const r = c.result();
    assert.strictEqual(r.model, 'gpt-5.6-sol');
    assert.strictEqual(r.usage.in, 100);
    assert.strictEqual(r.usage.cacheRead, 600);
    assert.strictEqual(r.usage.out, 25);
  });

  await test('Anthropic SSE merges message_start and message_delta', () => {
    const c = new StreamCapture();
    c.push('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":40,"output_tokens":1,"cache_read_input_tokens":9000}}}\n\n');
    c.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":333}}\n\n');
    const r = c.result();
    assert.strictEqual(r.model, 'claude-opus-4-8');
    assert.strictEqual(r.usage.in, 40);
    assert.strictEqual(r.usage.cacheRead, 9000);
    assert.strictEqual(r.usage.out, 333, 'final output count must win over the placeholder');
  });

  await test('frames split across chunk boundaries are recovered', () => {
    const c = new StreamCapture();
    c.push('data: {"model":"m","usage":{"prompt_to');
    c.push('kens":10,"completion_tokens":2}}\n\n');
    const r = c.result();
    assert.strictEqual(r.usage.out, 2);
    assert.strictEqual(r.model, 'm');
  });

  await test('a final frame without trailing newline is still captured', () => {
    const c = new StreamCapture();
    c.push('data: {"model":"m","usage":{"prompt_tokens":5,"completion_tokens":1}}');
    const r = c.result();
    assert.strictEqual(r.usage.out, 1);
  });

  await test('malformed frames are skipped without throwing', () => {
    const c = new StreamCapture();
    c.push('data: {broken json\n\n');
    c.push('data: {"model":"ok","usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    const r = c.result();
    assert.strictEqual(r.model, 'ok');
  });
}

// ---------------------------------------------------------------------------
// Request rewriting and routing
// ---------------------------------------------------------------------------

async function routingTests() {
  console.log('\nproxy: routing and request handling');

  await test('include_usage is injected only for OpenAI streaming requests', () => {
    const streaming = Buffer.from(JSON.stringify({ model: 'm', stream: true }));
    const out = ensureUsageReporting(streaming, 'openai');
    assert.strictEqual(out.modified, true);
    assert.strictEqual(JSON.parse(out.body.toString()).stream_options.include_usage, true);

    const nonStreaming = Buffer.from(JSON.stringify({ model: 'm' }));
    assert.strictEqual(ensureUsageReporting(nonStreaming, 'openai').modified, false);

    const anthropic = Buffer.from(JSON.stringify({ model: 'm', stream: true }));
    assert.strictEqual(ensureUsageReporting(anthropic, 'anthropic').modified, false,
      'Anthropic reports usage natively and must not be rewritten');

    const notJson = Buffer.from('--multipart--');
    assert.strictEqual(ensureUsageReporting(notJson, 'openai').modified, false);
  });

  await test('built-in and custom upstreams resolve', () => {
    assert.strictEqual(resolveUpstream('openrouter').host, 'openrouter.ai');
    assert.strictEqual(resolveUpstream('openrouter').basePath, '/api');
    assert.strictEqual(resolveUpstream('ollama').protocol, 'http:');
    assert.strictEqual(resolveUpstream('ollama').port, 11434);
    assert.strictEqual(resolveUpstream('nope'), null);

    const custom = resolveUpstream('mine', { mine: { baseUrl: 'http://10.0.0.5:9000/api' } });
    assert.strictEqual(custom.host, '10.0.0.5');
    assert.strictEqual(custom.port, 9000);
    assert.strictEqual(custom.protocol, 'http:');
    assert.strictEqual(custom.basePath, '/api');
  });

  await test('secrets are redacted from diagnostics', () => {
    const r = redactHeaders({ authorization: 'Bearer sk-secret', 'x-api-key': 'k', accept: 'application/json' });
    assert.strictEqual(r.authorization, '[redacted]');
    assert.strictEqual(r['x-api-key'], '[redacted]');
    assert.strictEqual(r.accept, 'application/json');
  });
}

// ---------------------------------------------------------------------------
// End-to-end against a fake upstream
// ---------------------------------------------------------------------------

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{port:number, close:() => Promise<void>}>}
 */
function startFakeUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        close: () => new Promise((r) => srv.close(r))
      });
    });
  });
}

/**
 * @param {number} port
 * @param {string} path
 * @param {object} payload
 * @returns {Promise<{status:number, body:string}>}
 */
function post(port, path, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: 'Bearer sk-test-secret' }
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function e2eTests() {
  console.log('\nproxy: end-to-end');

  await test('non-streaming call is forwarded and captured', async () => {
    let seenAuth = null;
    let seenPath = null;
    const upstream = await startFakeUpstream((req, res) => {
      seenAuth = req.headers.authorization;
      seenPath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'anthropic/claude-opus-4.8', // router resolved the alias
        usage: { prompt_tokens: 1000, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 900 } }
      }));
    });

    const events = [];
    const proxy = createProxyServer({
      onEvent: (e) => events.push(e),
      providers: { fake: { baseUrl: 'http://127.0.0.1:' + upstream.port + '/api' } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = proxy.address().port;

    const res = await post(proxyPort, '/opencode/fake/v1/chat/completions', { model: 'auto', messages: [] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seenPath, '/api/v1/chat/completions', 'basePath must prefix the client path');
    assert.strictEqual(seenAuth, 'Bearer sk-test-secret', 'credentials forwarded verbatim');

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(events.length, 1);
    const ev = events[0];
    assert.strictEqual(ev.harness, 'opencode');
    assert.strictEqual(ev.provider, 'fake');
    assert.strictEqual(ev.model, 'anthropic/claude-opus-4.8', 'served model wins over requested alias');
    assert.strictEqual(ev.requestedModel, 'auto');
    assert.strictEqual(ev.usage.in, 100);
    assert.strictEqual(ev.usage.cacheRead, 900);
    assert.strictEqual(ev.usage.out, 42);
    assert.ok(!JSON.stringify(ev).includes('sk-test-secret'), 'event must never contain credentials');

    proxy.close();
    await upstream.close();
  });

  await test('streaming call passes through and usage is captured', async () => {
    let injected = false;
    const upstream = await startFakeUpstream((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { injected = !!JSON.parse(body).stream_options.include_usage; } catch (_) { injected = false; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"model":"gpt-5.6-sol","choices":[{"delta":{"content":"hel"}}]}\n\n');
        res.write('data: {"model":"gpt-5.6-sol","choices":[{"delta":{"content":"lo"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":7}}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });

    const events = [];
    const proxy = createProxyServer({
      onEvent: (e) => events.push(e),
      providers: { fake: { baseUrl: 'http://127.0.0.1:' + upstream.port } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    const res = await post(proxy.address().port, '/pi/fake/v1/chat/completions', { model: 'gpt-5.6-sol', stream: true });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('hel') && res.body.includes('lo'), 'stream body forwarded intact');
    assert.ok(res.body.includes('[DONE]'));
    assert.strictEqual(injected, true, 'include_usage should be injected for streaming');

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].streamed, true);
    assert.strictEqual(events[0].usage.out, 7);
    assert.strictEqual(events[0].harness, 'pi');

    proxy.close();
    await upstream.close();
  });

  await test('upstream error still reaches the client', async () => {
    const upstream = await startFakeUpstream((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    const events = [];
    const proxy = createProxyServer({
      onEvent: (e) => events.push(e),
      providers: { fake: { baseUrl: 'http://127.0.0.1:' + upstream.port } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    const res = await post(proxy.address().port, '/hermes/fake/v1/chat/completions', { model: 'm' });
    assert.strictEqual(res.status, 429, 'status must be preserved');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(events[0].status, 429);

    proxy.close();
    await upstream.close();
  });

  await test('gzipped upstream response is still captured (regression: C1)', async () => {
    const zlib = require('zlib');
    let sawAcceptEncoding = null;
    const upstream = await startFakeUpstream((req, res) => {
      sawAcceptEncoding = req.headers['accept-encoding'];
      const payload = JSON.stringify({ model: 'm', usage: { prompt_tokens: 1000, completion_tokens: 50 } });
      if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from(payload)));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      }
    });
    const events = [];
    const proxy = createProxyServer({
      onEvent: (e) => events.push(e),
      providers: { fake: { baseUrl: 'http://127.0.0.1:' + upstream.port } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    // Emulate what undici (OpenAI SDK) sends by default.
    await new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ model: 'm' }));
      const rq = http.request({
        host: '127.0.0.1', port: proxy.address().port, path: '/oc/fake/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, 'accept-encoding': 'gzip, deflate, br' }
      }, (res) => { res.resume(); res.on('end', resolve); });
      rq.on('error', reject); rq.write(data); rq.end();
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!String(sawAcceptEncoding || '').includes('gzip'), 'accept-encoding must not reach upstream');
    assert.ok(events[0] && events[0].usage, 'usage must be captured despite the client requesting gzip');
    assert.strictEqual(events[0].usage.out, 50);
    proxy.close();
    await upstream.close();
  });

  await test('large integers survive usage injection (regression: H1)', () => {
    const big = '{"model":"m","stream":true,"seed":12345678901234567890}';
    const out = ensureUsageReporting(Buffer.from(big), 'openai');
    assert.strictEqual(out.modified, true);
    assert.ok(out.body.toString().includes('12345678901234567890'),
      'the original integer literal must be preserved byte-for-byte');
    assert.strictEqual(JSON.parse(out.body.toString()).stream_options.include_usage, true);
  });

  await test('Gemini JSON-array streaming captures usage (regression: H3)', async () => {
    const upstream = await startFakeUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { modelVersion: 'gemini-3.1-pro', candidates: [] },
        { modelVersion: 'gemini-3.1-pro', usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 60 } }
      ]));
    });
    const events = [];
    const proxy = createProxyServer({
      onEvent: (e) => events.push(e),
      providers: { g: { baseUrl: 'http://127.0.0.1:' + upstream.port, dialect: 'gemini' } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    await post(proxy.address().port, '/pi/g/v1beta/models/x:streamGenerateContent', { contents: [] });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(events[0].usage, 'array-shaped streaming body must yield usage');
    assert.strictEqual(events[0].usage.out, 60);
    assert.strictEqual(events[0].model, 'gemini-3.1-pro');
    proxy.close();
    await upstream.close();
  });

  await test('prototype keys cannot be used as providers (regression: M7)', async () => {
    const proxy = createProxyServer({ onEvent: () => {} });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    for (const key of ['constructor', '__proto__', 'toString']) {
      const res = await post(proxy.address().port, '/x/' + key + '/v1/chat', { model: 'm' });
      assert.strictEqual(res.status, 404, key + ' must not resolve to an upstream');
    }
    proxy.close();
  });

  await test('Connection-nominated headers are not forwarded (regression: M4)', async () => {
    let seen = null;
    const upstream = await startFakeUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"usage":{"prompt_tokens":1,"completion_tokens":1}}');
    });
    const proxy = createProxyServer({
      onEvent: () => {},
      providers: { fake: { baseUrl: 'http://127.0.0.1:' + upstream.port } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    await new Promise((resolve, reject) => {
      const data = Buffer.from('{"model":"m"}');
      const rq = http.request({
        host: '127.0.0.1', port: proxy.address().port, path: '/x/fake/v1/c', method: 'POST',
        headers: {
          'content-type': 'application/json', 'content-length': data.length,
          connection: 'x-internal-secret', 'x-internal-secret': 'leak-me'
        }
      }, (res) => { res.resume(); res.on('end', resolve); });
      rq.on('error', reject); rq.write(data); rq.end();
    });
    assert.strictEqual(seen['x-internal-secret'], undefined, 'hop-by-hop header must be dropped');
    proxy.close();
    await upstream.close();
  });

  await test('oversized body returns 413 to the client (regression: M3)', async () => {
    const proxy = createProxyServer({ onEvent: () => {}, maxRequestBytes: 512 });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const res = await post(proxy.address().port, '/x/openai/v1/chat', { model: 'm', pad: 'x'.repeat(4096) });
    assert.strictEqual(res.status, 413, 'client must actually receive the 413');
    proxy.close();
  });

  await test('unknown provider returns 404 without contacting anything', async () => {
    const proxy = createProxyServer({ onEvent: () => {} });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const res = await post(proxy.address().port, '/x/not-a-provider/v1/chat', { model: 'm' });
    assert.strictEqual(res.status, 404);
    proxy.close();
  });
}

(async () => {
  console.log('capture proxy tests');
  await dialectTests();
  await streamTests();
  await routingTests();
  await e2eTests();

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('\n' + f.name + '\n' + (f.err && f.err.stack));
    process.exit(1);
  }
})();
