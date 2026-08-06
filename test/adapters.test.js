'use strict';

/**
 * Adapter registry tests, including the Agent Zero server adapter.
 * Run: node test/adapters.test.js
 */

const http = require('http');
const assert = require('assert');

const adapters = require('../src/adapters');
const agentZero = require('../src/adapters/agent-zero');

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

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{url:string, close:() => Promise<void>}>}
 */
function fakeInstance(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port,
      close: () => new Promise((r) => srv.close(r))
    }));
  });
}

(async () => {
  console.log('adapter tests\n');
  console.log('registry');

  await test('adapters register and are retrievable', () => {
    assert.ok(adapters.get('agent-zero'), 'built-in adapter registered');
    assert.ok(adapters.list().length >= 1);
    assert.strictEqual(adapters.get('does-not-exist'), null);
  });

  await test('registering without an id is rejected', () => {
    assert.throws(() => adapters.register({}), /id/);
  });

  await test('a throwing adapter is contained, not propagated', async () => {
    adapters.register({
      id: 'explodes',
      label: 'Explodes',
      quota: () => { throw new Error('boom'); },
      tokens: () => { throw new Error('boom'); }
    });
    const quota = await adapters.collectQuota('explodes', {});
    assert.strictEqual(quota.status, 'error', 'failure surfaces as state, not a crash');
    assert.match(quota.message, /boom/);
    assert.strictEqual(adapters.collectTokens('explodes', {}), null);
  });

  await test('missing adapters and capabilities return null', async () => {
    assert.strictEqual(await adapters.collectQuota('nope', {}), null);
    assert.strictEqual(adapters.collectTokens('nope', {}), null);
    // agent-zero deliberately exposes no quota
    assert.strictEqual(await adapters.collectQuota('agent-zero', { config: {} }), null);
  });

  console.log('\nagent zero');

  await test('reads usage from a running instance', async () => {
    const instance = await fakeInstance((req, res) => {
      if (req.url === '/api/usage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tokens: { input: 12000, output: 3400 } }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const result = await agentZero.tokens({ config: { host: instance.url } });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.tokens.in, 12000);
    assert.strictEqual(result.tokens.out, 3400);
    assert.strictEqual(result.source, 'server-api');
    await instance.close();
  });

  await test('alternative response shapes are understood', async () => {
    const instance = await fakeInstance((req, res) => {
      if (req.url === '/api/usage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ usage: { input_tokens: 7, output_tokens: 8 } }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const result = await agentZero.tokens({ config: { host: instance.url } });
    assert.strictEqual(result.tokens.in, 7);
    assert.strictEqual(result.tokens.out, 8);
    await instance.close();
  });

  await test('a reachable instance without usage reports that, not zero', async () => {
    const instance = await fakeInstance((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const result = await agentZero.tokens({ config: { host: instance.url } });
    assert.strictEqual(result.status, 'no-usage-endpoint',
      'must not present an absent endpoint as zero usage');
    assert.ok(result.note.includes('proxy'));
    await instance.close();
  });

  await test('an unreachable instance is reported as unreachable', async () => {
    const result = await agentZero.tokens({ config: { host: 'http://127.0.0.1:1', timeoutMs: 500 } });
    assert.strictEqual(result.status, 'unreachable');
    assert.ok(result.note.includes('127.0.0.1:1'));
  });

  await test('a malformed host does not throw', async () => {
    const result = await agentZero.tokens({ config: { host: 'not a url', timeoutMs: 300 } });
    assert.ok(result && result.status, 'returns a state rather than throwing');
  });

  await test('disabled in config returns nothing', async () => {
    assert.strictEqual(await agentZero.tokens({ config: { enabled: false } }), null);
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('\n' + f.name + '\n' + (f.err && f.err.stack));
    process.exit(1);
  }
  process.exit(0);
})();
