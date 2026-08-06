#!/usr/bin/env node
'use strict';

/**
 * Regenerate the bundled OpenRouter-equivalent pricing catalogue.
 *
 * The output deliberately keeps only model ids and token-price fields. Model
 * descriptions, capabilities and other fast-changing metadata are excluded.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const SOURCE = 'https://openrouter.ai/api/v1/models';
const OUTPUT = path.join(__dirname, '..', 'src', 'core', 'pricing-snapshot.json');
const MIN_EXPECTED_MODELS = 300;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function prices(raw) {
  const source = raw || {};
  const out = {
    prompt: number(source.prompt),
    completion: number(source.completion),
    cacheRead: number(source.input_cache_read),
    cacheWrite: number(source.input_cache_write),
    cacheWrite1h: number(source.input_cache_write_1h),
    internalReasoning: number(source.internal_reasoning)
  };
  if (Array.isArray(source.overrides)) {
    out.overrides = source.overrides.map((entry) => ({
      minPromptTokens: number(entry.min_prompt_tokens),
      prompt: number(entry.prompt),
      completion: number(entry.completion),
      cacheRead: number(entry.input_cache_read),
      cacheWrite: number(entry.input_cache_write),
      cacheWrite1h: number(entry.input_cache_write_1h),
      internalReasoning: number(entry.internal_reasoning)
    })).filter((entry) => entry.minPromptTokens != null);
  }
  return out;
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('OpenRouter returned HTTP ' + response.statusCode));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error('OpenRouter returned invalid JSON: ' + err.message)); }
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error('OpenRouter request timed out')));
    request.on('error', reject);
  });
}

function aliasesFor(ids) {
  const owners = new Map();
  const add = (alias, id) => {
    if (!alias || alias === id) return;
    if (!owners.has(alias)) owners.set(alias, id);
    else if (owners.get(alias) !== id) owners.set(alias, null);
  };
  for (const id of ids) {
    const suffix = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
    add(suffix, id);
    add(suffix.replace(/\.(\d+)/g, '-$1'), id);
  }
  return Object.fromEntries([...owners.entries()].filter(([, id]) => id).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const inputIndex = process.argv.indexOf('--input');
  const payload = inputIndex >= 0
    ? JSON.parse(fs.readFileSync(path.resolve(process.argv[inputIndex + 1]), 'utf8'))
    : await getJSON(SOURCE);
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  if (rows.length < MIN_EXPECTED_MODELS) {
    throw new Error('refusing incomplete catalogue: expected at least ' + MIN_EXPECTED_MODELS + ', received ' + rows.length);
  }

  const models = {};
  for (const row of rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    const trimmed = prices(row.pricing);
    if (trimmed.prompt == null || trimmed.completion == null) {
      throw new Error('model is missing prompt/completion pricing: ' + row.id);
    }
    models[row.id] = trimmed;
  }
  if (Object.keys(models).length !== rows.length) {
    throw new Error('refusing partial snapshot: retained ' + Object.keys(models).length + ' of ' + rows.length + ' models');
  }

  const now = new Date();
  const snapshot = {
    version: 'openrouter-' + now.toISOString().slice(0, 10),
    asOf: now.toISOString(),
    source: SOURCE,
    modelCount: Object.keys(models).length,
    unattributedInputRatio: 0.8,
    models,
    aliases: aliasesFor(Object.keys(models))
  };
  const temporary = OUTPUT + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, OUTPUT);
  console.log('Wrote ' + snapshot.modelCount + ' models to ' + path.relative(process.cwd(), OUTPUT));
  console.log('Version ' + snapshot.version + ' as of ' + snapshot.asOf);
}

main().catch((err) => {
  console.error(err && err.message || err);
  process.exit(1);
});
