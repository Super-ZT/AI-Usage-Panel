'use strict';

/**
 * Local subscription-log bridge and shared pricing tests.
 * Uses synthetic logs only; source secrets/content must never enter events.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-local-'));
const dataDir = path.join(scratch, 'data');
const claudeHome = path.join(scratch, 'claude');
const codexHome = path.join(scratch, 'codex');
const grokHome = path.join(scratch, 'grok');
process.env.USAGE_PANEL_DATA_DIR = dataDir;

const events = require('../src/core/events');
let localUsage = require('../src/core/local-usage');
const pricing = require('../src/core/pricing');

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

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

function appendLine(file, line) {
  fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
}

const claudeFile = path.join(claudeHome, 'projects', 'project-a', 'session.jsonl');
const codexFile = path.join(codexHome, 'sessions', '2026', '08', 'rollout-session-a.jsonl');
const grokDir = path.join(grokHome, 'sessions', 'grok-session-a');
const grokFile = path.join(grokDir, 'updates.jsonl');
const realProbeFile = path.join(__dirname, '..', 'scripts', 'fixtures', 'codex-real-probe-2026-08-06.jsonl');
const device = { id: 'device-local-0001' };

const claudeRow = {
  type: 'assistant',
  timestamp: '2026-08-03T10:00:00.000Z',
  requestId: 'request-secret-safe-id',
  prompt: 'PRIVATE PROMPT MUST NOT LEAVE THIS FILE',
  apiKey: 'sk-private-never-upload',
  message: {
    id: 'msg_fixture_1',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'PRIVATE COMPLETION' }],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40
    }
  }
};
const claudeDuplicate = JSON.parse(JSON.stringify(claudeRow));
claudeDuplicate.timestamp = '2026-08-03T10:00:00.005Z';
const claudeGrowing = JSON.parse(JSON.stringify(claudeRow));
claudeGrowing.timestamp = '2026-08-03T10:00:00.010Z';
claudeGrowing.message.usage.output_tokens = 30;
claudeGrowing.message.usage.cache_read_input_tokens = 320;

const codexModel = {
  timestamp: '2026-08-03T10:01:00.000Z',
  payload: { model: 'gpt-5.6-sol', content: 'PRIVATE CODEX CONTENT' }
};
const codexFirst = {
  timestamp: '2026-08-03T10:02:00.000Z',
  payload: { info: { total_token_usage: {
    input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, cache_write_input_tokens: 10
  } } }
};
const codexSecond = {
  timestamp: '2026-08-03T10:03:00.000Z',
  payload: { info: { total_token_usage: {
    input_tokens: 160, output_tokens: 35, cached_input_tokens: 70, cache_write_input_tokens: 15
  } } }
};

(async () => {
  console.log('local usage bridge tests\n');

  writeLines(claudeFile, [claudeRow, claudeDuplicate, claudeGrowing]);
  writeLines(codexFile, [codexModel, codexFirst, codexSecond]);
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(path.join(grokDir, 'summary.json'), JSON.stringify({ current_model_id: 'grok-4.5' }), 'utf8');
  writeLines(grokFile, [
    { timestamp: 1785751440, _meta: { totalTokens: 50 }, content: 'PRIVATE GROK CONTENT' },
    { timestamp: 1785751500, _meta: { totalTokens: 80 } }
  ]);

  await test('first scan emits exact token facts from Claude, Codex and Grok', async () => {
    const result = await localUsage.bridge({ claudeHome, codexHome, grokHome, device, eventStore: events });
    assert.strictEqual(result.written, 6);
    const all = events.read({ from: '2026-08-03', to: '2026-08-03' });
    assert.strictEqual(all.length, 6);

    const claude = all.filter((event) => event.harness === 'claude-code');
    const employeeTotal = [claudeRow, claudeDuplicate, claudeGrowing].reduce((sum, row) => {
      return localUsage.mergeClaudeTokens(sum, localUsage.claudeTokensFromUsage(row.message.usage));
    }, {});
    const emittedTotal = claude.reduce((sum, event) => ({
      in: sum.in + event.tokens.in,
      out: sum.out + event.tokens.out,
      cache_read: sum.cache_read + event.tokens.cache_read,
      cache_write: sum.cache_write + event.tokens.cache_write,
      cache_write_5m: sum.cache_write_5m + event.tokens.cache_write_5m,
      cache_write_1h: sum.cache_write_1h + event.tokens.cache_write_1h
    }), { in: 0, out: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 });
    assert.strictEqual(claude.length, 2, 'exact duplicate emits nothing; growing row emits one top-up');
    assert.deepStrictEqual(employeeTotal, {
      in: 100, out: 30, cache_read: 320, cache_write: 40,
      cache_write_5m: 0, cache_write_1h: 0
    });
    assert.deepStrictEqual(emittedTotal, employeeTotal, 'employee and emitted totals must match');
    assert.strictEqual(new Set(claude.map((event) => event.ts)).size, 1,
      'top-ups stay attributed to the original reply time');
    const codex = all.filter((event) => event.harness === 'codex');
    assert.deepStrictEqual(codex.map((event) => event.tokens), [
      {
        in: 50, out: 20, cache_read: 40, cache_write: 10,
        cache_write_5m: 0, cache_write_1h: 0, cache_write_unresolved: 0,
        reasoning: 0, unattributed: 0
      },
      {
        in: 25, out: 15, cache_read: 30, cache_write: 5,
        cache_write_5m: 0, cache_write_1h: 0, cache_write_unresolved: 0,
        reasoning: 0, unattributed: 0
      }
    ]);
    const grok = all.filter((event) => event.harness === 'grok-build');
    assert.deepStrictEqual(grok.map((event) => event.tokens.unattributed), [50, 30]);
  });

  await test('real Codex 0.146 subscription workload preserves every native counter and model', () => {
    const rows = fs.readFileSync(realProbeFile, 'utf8').trim().split(/\r?\n/);
    const runtime = {};
    const emitted = rows.map((line) => localUsage.codexEvent(
      line, device.id, 'synthetic-codex-accuracy-probe', runtime
    )).filter(Boolean);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].model, 'gpt-5.6-sol');
    assert.strictEqual(emitted[0].pricing_model, 'gpt-5.6-sol');
    assert.deepStrictEqual(emitted[0].tokens, {
      in: 15896, out: 15, cache_read: 3712, cache_write: 0,
      reasoning: 0, unattributed: 0, missing: []
    });
    const native = rows.map(JSON.parse)
      .find((row) => row.payload && row.payload.type === 'token_count')
      .payload.info.total_token_usage;
    assert.strictEqual(emitted[0].tokens.in + emitted[0].tokens.cache_read
      + emitted[0].tokens.cache_write, native.input_tokens);
    const estimated = pricing.priceTokens(emitted[0].pricing_model, emitted[0].tokens);
    assert.strictEqual(estimated.status, 'priced');
    assert.strictEqual(estimated.version, 'openrouter-2026-08-03');
    assert.ok(Math.abs(estimated.amount - 0.081786) < 1e-12);
    assert.ok(Math.abs(estimated.flatAmount - 0.09849) < 1e-12);
  });

  await test('uploadable events contain no prompts, completions, files or credentials', () => {
    const serialized = JSON.stringify(events.read({ from: '2026-08-03', to: '2026-08-03' }));
    for (const forbidden of [
      'PRIVATE PROMPT', 'PRIVATE COMPLETION', 'PRIVATE CODEX', 'PRIVATE GROK',
      'sk-private-never-upload', 'apiKey', 'content', claudeFile, codexFile, grokFile
    ]) {
      assert.ok(!serialized.includes(forbidden), 'event payload leaked: ' + forbidden);
    }
  });

  await test('durable checkpoints and event ids prevent replay after restart', async () => {
    const before = events.read({ from: '2026-08-03', to: '2026-08-03' }).length;
    const replay = await localUsage.bridge({ claudeHome, codexHome, grokHome, device, eventStore: events });
    assert.strictEqual(replay.written, 0);
    assert.strictEqual(events.read({ from: '2026-08-03', to: '2026-08-03' }).length, before);

    delete require.cache[require.resolve('../src/core/local-usage')];
    localUsage = require('../src/core/local-usage');
    const restarted = await localUsage.bridge({ claudeHome, codexHome, grokHome, device, eventStore: events });
    assert.strictEqual(restarted.written, 0);
    assert.ok(fs.existsSync(localUsage.checkpointPath()), 'checkpoint must survive process reload');
  });

  await test('only newly appended source rows are emitted', async () => {
    appendLine(claudeFile, {
      type: 'assistant', timestamp: '2026-08-03T10:04:00.000Z', requestId: 'request-2',
      message: { id: 'msg_fixture_2', model: 'claude-opus-4-8', usage: { input_tokens: 7, output_tokens: 3 } }
    });
    const result = await localUsage.bridge({ claudeHome, codexHome, grokHome, device, eventStore: events });
    assert.strictEqual(result.written, 1);
    const all = events.read({ from: '2026-08-03', to: '2026-08-03' });
    assert.strictEqual(all.length, 7);
  });

  console.log('\nshared pricing tests\n');

  await test('known token categories use the bundled OpenRouter snapshot', () => {
    const result = pricing.priceTokens('claude-opus-4-8', {
      in: 100, out: 20, cache_read: 300, cache_write: 40
    });
    const expected = 100 * 0.000005 + 20 * 0.000025
      + 300 * 0.0000005 + 40 * 0.00000625;
    assert.strictEqual(result.status, 'priced');
    assert.ok(Math.abs(result.amount - expected) < 1e-12);
    assert.strictEqual(result.version, pricing.snapshot.version);
  });

  await test('the bundled snapshot covers the full catalogue and representative model families', () => {
    assert.ok(pricing.snapshot.modelCount >= 300, 'expected a full OpenRouter catalogue');
    assert.strictEqual(Object.keys(pricing.snapshot.models).length, pricing.snapshot.modelCount);
    const aliases = {
      'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
      'gpt-5.1': 'openai/gpt-5.1',
      'grok-4.3': 'x-ai/grok-4.3',
      'gemini-3.6-flash': 'google/gemini-3.6-flash',
      'kimi-k2.5': 'moonshotai/kimi-k2.5',
      'glm-5': 'z-ai/glm-5',
      'qwen3.7-flash': 'qwen/qwen3.7-flash',
      'deepseek-v3.2': 'deepseek/deepseek-v3.2'
    };
    for (const [local, expected] of Object.entries(aliases)) {
      const found = pricing.resolve(local);
      assert.ok(found, 'missing representative model ' + local);
      assert.strictEqual(found.id, expected);
    }
  });

  await test('long-context pricing uses the catalogue threshold for that request', () => {
    const short = pricing.priceTokens('qwen3.7-flash', { in: 31000, out: 100 });
    const long = pricing.priceTokens('qwen3.7-flash', { in: 32000, out: 100 });
    assert.ok(Math.abs(short.amount - (31000 * 0.00000003 + 100 * 0.00000013)) < 1e-12);
    assert.ok(Math.abs(long.amount - (32000 * 0.0000001 + 100 * 0.0000004)) < 1e-12);
  });

  await test('a source with no input/output split is priced but visibly partial', () => {
    const result = pricing.priceTokens('grok-4.5', { unattributed: 1000 });
    assert.strictEqual(result.status, 'partial');
    assert.ok(result.amount > 0);
    assert.strictEqual(result.unattributedTokens, 1000);
  });

  await test('missing Codex cache-write evidence remains visibly partial', () => {
    const runtime = { model: 'gpt-5.6-sol' };
    const event = localUsage.codexEvent(JSON.stringify({
      timestamp: '2026-08-03T11:00:00.000Z',
      payload: { info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20 } } }
    }), device.id, 'missing-cache-write', runtime);
    assert.deepStrictEqual(event.tokens.missing, ['cache_write']);
    assert.strictEqual(pricing.priceTokens(event.pricing_model, event.tokens).status, 'partial');
  });

  await test('a temporarily absent cache-write field cannot reset and duplicate cumulative counters', () => {
    const runtime = { model: 'gpt-5.6-sol' };
    const row = (timestamp, usage) => localUsage.codexEvent(JSON.stringify({
      timestamp, payload: { info: { total_token_usage: usage } }
    }), device.id, 'mixed-cache-write', runtime);
    row('2026-08-03T11:02:00.000Z', {
      input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 10
    });
    const absent = row('2026-08-03T11:03:00.000Z', {
      input_tokens: 120, output_tokens: 12, cached_input_tokens: 30
    });
    assert.deepStrictEqual(absent.tokens, {
      in: 10, out: 2, cache_read: 10, cache_write: 0,
      reasoning: 0, unattributed: 0, missing: ['cache_write']
    });
    const restored = row('2026-08-03T11:04:00.000Z', {
      input_tokens: 130, output_tokens: 13, cached_input_tokens: 35, cache_write_input_tokens: 12
    });
    assert.deepStrictEqual(restored.tokens, {
      in: 3, out: 1, cache_read: 5, cache_write: 2,
      reasoning: 0, unattributed: 0, missing: []
    });
  });

  await test('a counter reset without cache-write evidence cannot reuse the prior epoch total', () => {
    const runtime = { model: 'gpt-5.6-sol' };
    const row = (timestamp, usage) => localUsage.codexEvent(JSON.stringify({
      timestamp, payload: { info: { total_token_usage: usage } }
    }), device.id, 'reset-missing-cache-write', runtime);
    row('2026-08-03T11:05:00.000Z', {
      input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 10
    });
    const reset = row('2026-08-03T11:06:00.000Z', {
      input_tokens: 25, output_tokens: 2, cached_input_tokens: 5
    });
    assert.deepStrictEqual(reset.tokens, {
      in: 20, out: 2, cache_read: 5, cache_write: 0,
      reasoning: 0, unattributed: 0, missing: ['cache_write']
    });
  });

  await test('missing Codex model identity is unknown and cannot be priced by a fallback', () => {
    const event = localUsage.codexEvent(JSON.stringify({
      timestamp: '2026-08-03T11:01:00.000Z',
      payload: { info: { total_token_usage: {
        input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 0
      } } }
    }), device.id, 'missing-model', {}, 'gpt-5.6-sol');
    assert.strictEqual(event.model, 'unknown');
    assert.strictEqual(event.pricing_model, null);
    assert.strictEqual(pricing.priceTokens(event.pricing_model, event.tokens).status, 'unknown');
  });

  await test('an unknown model is unknown rather than silently priced at zero', () => {
    const result = pricing.priceTokens('model-not-in-snapshot', { in: 100, out: 10 });
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.amount, null);
    assert.strictEqual(result.flatAmount, null);
  });

  await test('negative catalogue rates are unknown rather than subtracting cost', () => {
    const result = pricing.priceTokens('negative-rate-model', { in: 100, out: 10 }, {
      overrides: {
        'negative-rate-model': { id: 'custom/negative', prompt: -0.01, completion: 0.02 }
      }
    });
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.amount, null);
  });

  await test('a complete final JSON line is committed at stable end-of-file without a newline', () => {
    const file = path.join(scratch, 'complete-unterminated.jsonl');
    const row = JSON.stringify({ value: 'complete-json-without-newline' });
    fs.writeFileSync(file, row, 'utf8');
    const seen = [];
    const checkpoint = localUsage.scanIncremental(file, {}, (line) => seen.push(JSON.parse(line)));
    assert.deepStrictEqual(seen, [{ value: 'complete-json-without-newline' }]);
    assert.strictEqual(checkpoint.offset, Buffer.byteLength(row));
  });

  await test('an incomplete final JSON line stays pending without advancing its checkpoint', () => {
    const file = path.join(scratch, 'incomplete-unterminated.jsonl');
    const partial = '{"value":"writer-still-active';
    fs.writeFileSync(file, partial, 'utf8');
    const seen = [];
    const checkpoint = localUsage.scanIncremental(file, {}, (line) => seen.push(line));
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(checkpoint.offset, 0);
  });

  await test('a retained partial line is processed once after a later append completes it', () => {
    const file = path.join(scratch, 'later-completed.jsonl');
    const partial = '{"value":"later-completed';
    fs.writeFileSync(file, partial, 'utf8');
    const seen = [];
    const pending = localUsage.scanIncremental(file, {}, (line) => seen.push(JSON.parse(line)));
    assert.strictEqual(pending.offset, 0);
    fs.appendFileSync(file, '"}', 'utf8');
    const completed = localUsage.scanIncremental(file, pending, (line) => seen.push(JSON.parse(line)));
    assert.deepStrictEqual(seen, [{ value: 'later-completed' }]);
    assert.strictEqual(completed.offset, fs.statSync(file).size);
  });

  await test('split UTF-8 in a complete unterminated line survives chunk boundaries', () => {
    const file = path.join(scratch, 'split-utf8.jsonl');
    const prefix = '{"value":"' + 'x'.repeat(64 * 1024 - Buffer.byteLength('{"value":"') - 1);
    const row = prefix + '€"}';
    assert.strictEqual(Buffer.byteLength(prefix), 64 * 1024 - 1);
    fs.writeFileSync(file, row, 'utf8');
    const seen = [];
    const checkpoint = localUsage.scanIncremental(file, {}, (line) => seen.push(JSON.parse(line)));
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0].value.endsWith('€'));
    assert.strictEqual(checkpoint.offset, Buffer.byteLength(row));
  });

  await test('a committed unterminated line is not emitted again from its saved checkpoint', () => {
    const file = path.join(scratch, 'unterminated-no-duplicate.jsonl');
    const row = JSON.stringify({ value: 'emit-once' });
    fs.writeFileSync(file, row, 'utf8');
    const seen = [];
    const checkpoint = localUsage.scanIncremental(file, {}, (line) => seen.push(JSON.parse(line)));
    const unchanged = localUsage.scanIncremental(file, checkpoint, (line) => seen.push(JSON.parse(line)));
    assert.deepStrictEqual(seen, [{ value: 'emit-once' }]);
    assert.strictEqual(unchanged.offset, checkpoint.offset);
  });

  await test('staged Claude 1h cache writes price at cacheWrite1h (openrouter-2026-08-03)', () => {
    // Exact staged measurement shape: 1h writes were collapsed to aggregate
    // cache_write and billed at the five-minute rate ($0.00835). Correct bill
    // under anthropic/claude-haiku-4.5 is $0.01318.
    assert.strictEqual(pricing.snapshot.version, 'openrouter-2026-08-03');
    const staged = {
      in: 10,
      out: 58,
      cache_read: 0,
      cache_write: 6440,
      cache_write_5m: 0,
      cache_write_1h: 6440
    };
    const wrong = pricing.priceTokens('claude-haiku-4-5', {
      in: 10, out: 58, cache_read: 0, cache_write: 6440
    });
    assert.ok(Math.abs(wrong.amount - 0.00835) < 1e-12, 'legacy aggregate still uses 5m rate');
    const priced = pricing.priceTokens('claude-haiku-4-5', staged);
    assert.strictEqual(priced.status, 'priced');
    assert.strictEqual(priced.version, 'openrouter-2026-08-03');
    assert.ok(Math.abs(priced.amount - 0.01318) < 1e-12, 'got ' + priced.amount);
  });

  await test('five-minute cache writes keep the cacheWrite rate', () => {
    const priced = pricing.priceTokens('claude-haiku-4-5', {
      in: 10, out: 58, cache_write: 6440, cache_write_5m: 6440, cache_write_1h: 0
    });
    assert.strictEqual(priced.status, 'priced');
    assert.ok(Math.abs(priced.amount - 0.00835) < 1e-12);
  });

  await test('mixed five-minute and one-hour cache writes price each duration', () => {
    const priced = pricing.priceTokens('claude-haiku-4-5', {
      in: 0, out: 0,
      cache_write: 3000,
      cache_write_5m: 1000,
      cache_write_1h: 2000
    });
    const expected = 1000 * 0.00000125 + 2000 * 0.000002;
    assert.strictEqual(priced.status, 'priced');
    assert.ok(Math.abs(priced.amount - expected) < 1e-12);
  });

  await test('legacy aggregate-only cache_write stays on the five-minute rate', () => {
    const priced = pricing.priceTokens('claude-haiku-4-5', {
      in: 10, out: 58, cache_write: 6440
    });
    assert.strictEqual(priced.status, 'priced');
    assert.ok(Math.abs(priced.amount - 0.00835) < 1e-12);
    assert.strictEqual(priced.unpricedCacheWriteTokens || 0, 0);
  });

  await test('unknown one-hour catalogue rate is partial rather than silent 5m misprice', () => {
    const priced = pricing.priceTokens('claude-haiku-4-5', {
      in: 10, out: 0, cache_write: 100, cache_write_1h: 100
    }, {
      overrides: {
        'claude-haiku-4-5': {
          id: 'custom/no-1h',
          prompt: 0.000001,
          completion: 0.000005,
          cacheWrite: 0.00000125
          // deliberately omit cacheWrite1h
        }
      }
    });
    assert.strictEqual(priced.status, 'partial');
    assert.ok(Math.abs(priced.amount - 10 * 0.000001) < 1e-12);
    assert.strictEqual(priced.unpricedCacheWriteTokens, 100);
  });

  await test('unresolved cache-write duration marks partial without inventing dollars', () => {
    const priced = pricing.priceTokens('claude-haiku-4-5', {
      in: 0, out: 0, cache_write: 100, cache_write_1h: 100, cache_write_unresolved: 50
    });
    assert.strictEqual(priced.status, 'partial');
    assert.ok(Math.abs(priced.amount - 100 * 0.000002) < 1e-12);
    assert.strictEqual(priced.unpricedCacheWriteTokens, 50);
  });

  await test('Claude transcript cache_creation duration survives bridge serialization', async () => {
    const durationFile = path.join(claudeHome, 'projects', 'project-b', 'session-1h.jsonl');
    writeLines(durationFile, [{
      type: 'assistant',
      timestamp: '2026-08-03T12:00:00.000Z',
      requestId: 'request-1h-duration',
      prompt: 'PRIVATE PROMPT MUST NOT LEAVE THIS FILE',
      message: {
        id: 'msg_fixture_1h',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'PRIVATE COMPLETION' }],
        usage: {
          input_tokens: 10,
          output_tokens: 58,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 6440,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 6440
          }
        }
      }
    }]);
    const result = await localUsage.bridge({
      claudeHome, codexHome, grokHome, device, eventStore: events
    });
    assert.ok(result.written >= 1);
    const all = events.read({ from: '2026-08-03', to: '2026-08-03' });
    const row = all.find((event) => event.model === 'claude-haiku-4-5'
      && event.tokens.cache_write_1h === 6440);
    assert.ok(row, 'duration-split Claude event must be stored');
    assert.deepStrictEqual(row.tokens, {
      in: 10, out: 58, cache_read: 0, cache_write: 6440,
      cache_write_5m: 0, cache_write_1h: 6440, cache_write_unresolved: 0,
      reasoning: 0, unattributed: 0
    });
    const serialized = JSON.stringify(row);
    assert.ok(serialized.includes('"cache_write_1h":6440'));
    assert.ok(!serialized.includes('PRIVATE PROMPT'));
    const priced = pricing.priceTokens(row.model, row.tokens);
    assert.strictEqual(priced.status, 'priced');
    assert.ok(Math.abs(priced.amount - 0.01318) < 1e-12);
  });

  await test('progressive aggregate-then-1h marks discarded duration unresolved', () => {
    // Case A: aggregate 3000 first, then write=6440 with 1h=6440.
    // Cap keeps write total 6440; discarded 3000 known-1h tokens must be partial.
    const ledger = {};
    const firstLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-03T13:00:00.000Z',
      requestId: 'request-progressive-1h',
      message: {
        id: 'msg_progressive_1h',
        model: 'claude-haiku-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 58,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 3000
        }
      }
    });
    const secondLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-03T13:00:00.050Z',
      requestId: 'request-progressive-1h',
      message: {
        id: 'msg_progressive_1h',
        model: 'claude-haiku-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 58,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 6440,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 6440
          }
        }
      }
    });
    const first = localUsage.claudeEvent(firstLine, device.id, ledger);
    const second = localUsage.claudeEvent(secondLine, device.id, ledger);
    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(first.tokens.cache_write, 3000);
    assert.strictEqual(first.tokens.cache_write_1h, 0);
    assert.strictEqual(first.tokens.cache_write_unresolved || 0, 0);
    assert.strictEqual(second.tokens.cache_write, 3440, 'only the aggregate growth is new');
    assert.strictEqual(second.tokens.cache_write_1h, 3440,
      '1h delta must not re-emit the already-billed 3000');
    assert.strictEqual(second.tokens.cache_write_5m, 0);
    assert.strictEqual(second.tokens.cache_write_unresolved, 3000,
      'discarded known 1h attribution must be recorded');

    const writeTotal = first.tokens.cache_write + second.tokens.cache_write;
    assert.strictEqual(writeTotal, 6440, 'events must cover 6440 cache-write tokens, never 9440');
    assert.notStrictEqual(writeTotal, 9440);

    const firstPrice = pricing.priceTokens('claude-haiku-4-5', first.tokens);
    const secondPrice = pricing.priceTokens('claude-haiku-4-5', second.tokens);
    assert.strictEqual(firstPrice.status, 'priced');
    assert.strictEqual(secondPrice.status, 'partial');
    assert.strictEqual(secondPrice.unpricedCacheWriteTokens, 3000);
    // Money still underbills the full-1h ideal (cannot rewrite event 1) but is honest.
    const writeMoney = (firstPrice.amount - 10 * 0.000001 - 58 * 0.000005)
      + secondPrice.amount;
    assert.ok(Math.abs(writeMoney - (3000 * 0.00000125 + 3440 * 0.000002)) < 1e-12);
  });

  await test('progressive 1h-then-aggregate marks pure-legacy growth unresolved', () => {
    // Case B: 1h split first on 3000, then aggregate-only growth to 6440.
    const ledger = {};
    const firstLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-03T14:00:00.000Z',
      requestId: 'request-progressive-1h-first',
      message: {
        id: 'msg_progressive_1h_first',
        model: 'claude-haiku-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 58,
          cache_creation_input_tokens: 3000,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 3000
          }
        }
      }
    });
    const secondLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-03T14:00:00.050Z',
      requestId: 'request-progressive-1h-first',
      message: {
        id: 'msg_progressive_1h_first',
        model: 'claude-haiku-4-5',
        usage: {
          input_tokens: 10,
          output_tokens: 58,
          cache_creation_input_tokens: 6440
        }
      }
    });
    const first = localUsage.claudeEvent(firstLine, device.id, ledger);
    const second = localUsage.claudeEvent(secondLine, device.id, ledger);
    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(first.tokens.cache_write, 3000);
    assert.strictEqual(first.tokens.cache_write_1h, 3000);
    assert.strictEqual(first.tokens.cache_write_unresolved || 0, 0);
    assert.strictEqual(second.tokens.cache_write, 3440);
    assert.strictEqual(second.tokens.cache_write_1h, 0);
    assert.strictEqual(second.tokens.cache_write_unresolved, 3440,
      'aggregate growth after a duration sighting is unresolved, not exact 5m');
    assert.strictEqual(
      first.tokens.cache_write + second.tokens.cache_write,
      6440
    );

    const firstPrice = pricing.priceTokens('claude-haiku-4-5', first.tokens);
    const secondPrice = pricing.priceTokens('claude-haiku-4-5', second.tokens);
    assert.strictEqual(firstPrice.status, 'priced');
    assert.strictEqual(secondPrice.status, 'partial');
    assert.strictEqual(secondPrice.unpricedCacheWriteTokens, 3440);
  });

  await test('pricing caps duration tokens that exceed aggregate cache_write', () => {
    const oneExceeds = pricing.priceTokens('claude-haiku-4-5', {
      in: 0, out: 0, cache_write: 1000, cache_write_1h: 5000
    });
    assert.strictEqual(oneExceeds.status, 'partial');
    assert.ok(Math.abs(oneExceeds.amount - 1000 * 0.000002) < 1e-12);
    assert.strictEqual(oneExceeds.unpricedCacheWriteTokens, 4000);

    const fiveExceeds = pricing.priceTokens('claude-haiku-4-5', {
      in: 0, out: 0, cache_write: 500, cache_write_5m: 2000
    });
    assert.strictEqual(fiveExceeds.status, 'partial');
    assert.ok(Math.abs(fiveExceeds.amount - 500 * 0.00000125) < 1e-12);
    assert.strictEqual(fiveExceeds.unpricedCacheWriteTokens, 1500);

    const sumExceeds = pricing.priceTokens('claude-haiku-4-5', {
      in: 0, out: 0, cache_write: 1000, cache_write_5m: 800, cache_write_1h: 800
    });
    assert.strictEqual(sumExceeds.status, 'partial');
    // 5m takes min(800,1000)=800; 1h takes min(800,200)=200; overflow 600
    assert.ok(Math.abs(sumExceeds.amount - (800 * 0.00000125 + 200 * 0.000002)) < 1e-12);
    assert.strictEqual(sumExceeds.unpricedCacheWriteTokens, 600);
  });

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const failure of failures) console.log('\n' + failure.name + '\n' + (failure.err && failure.err.stack));
    process.exit(1);
  }
  process.exit(0);
})();
