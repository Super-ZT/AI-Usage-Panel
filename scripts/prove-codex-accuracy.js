'use strict';

/**
 * Reproduce the sanitized, subscription-native Codex accuracy proof without
 * reading auth, prompts, completions, or any live account.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const localUsage = require('../src/core/local-usage');
const pricing = require('../src/core/pricing');

const fixture = path.join(__dirname, 'fixtures', 'codex-real-probe-2026-08-06.jsonl');
const rows = fs.readFileSync(fixture, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const runtime = {};
const events = rows.map((row) => localUsage.codexEvent(
  JSON.stringify(row), 'accuracy-proof-device', 'synthetic-codex-accuracy-probe', runtime
)).filter(Boolean);

assert.strictEqual(events.length, 1);
const event = events[0];
const native = rows.find((row) => row.payload && row.payload.type === 'token_count');
const total = native.payload.info.total_token_usage;
const estimate = pricing.priceTokens(event.pricing_model, event.tokens);

assert.strictEqual(event.model, 'gpt-5.6-sol');
assert.deepStrictEqual(event.tokens, {
  in: 15896, out: 15, cache_read: 3712, cache_write: 0,
  reasoning: 0, unattributed: 0, missing: []
});
assert.strictEqual(event.tokens.in + event.tokens.cache_read + event.tokens.cache_write, total.input_tokens);
assert.strictEqual(estimate.status, 'priced');
assert.ok(Math.abs(estimate.amount - 0.081786) < 1e-12);
assert.ok(Math.abs(estimate.flatAmount - 0.09849) < 1e-12);

console.log(JSON.stringify({
  workload: {
    prompt: 'Without using tools, reply with exactly: USAGE_PANEL_CODEX_PROBE_20260806',
    response: 'USAGE_PANEL_CODEX_PROBE_20260806',
    codexCli: '0.146.0'
  },
  native: {
    model: event.model,
    inputInclusive: total.input_tokens,
    output: total.output_tokens,
    cacheRead: total.cached_input_tokens,
    cacheWrite: total.cache_write_input_tokens,
    reasoningOutput: total.reasoning_output_tokens
  },
  panelEvent: {
    model: event.model,
    pricingModel: event.pricing_model,
    tokens: event.tokens,
    source: event.source
  },
  openrouterEquivalent: {
    status: estimate.status,
    amountUsd: Number(estimate.amount.toFixed(6)),
    flatAmountUsd: Number(estimate.flatAmount.toFixed(6)),
    catalogueVersion: estimate.version,
    catalogueModel: estimate.model
  },
  reconciliation: {
    independentProviderEvent: 'unknown',
    managerAccountWindow: 'unknown'
  }
}, null, 2));
