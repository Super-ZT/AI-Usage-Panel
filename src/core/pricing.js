'use strict';

/**
 * Versioned OpenRouter-equivalent pricing shared by the desktop and collector.
 *
 * Prices are deliberately bundled instead of fetched independently by every
 * process. A desktop and its collector must use the same catalogue version or
 * their dollar totals can disagree even when their token facts are identical.
 * Unknown models remain visible as unpriced rather than silently becoming $0.
 */

const snapshot = require('./pricing-snapshot.json');

/** @param {any} value @returns {number} */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** @param {string} name @returns {string} */
function normalizeModel(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/-build$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * Resolve a local model label to one entry in the bundled catalogue.
 * @param {string|null} model
 * @param {object} [overrides]
 * @returns {{id:string,price:object}|null}
 */
function resolve(model, overrides) {
  if (!model) return null;
  const raw = String(model);
  const override = overrides && (overrides[raw] || overrides[raw.toLowerCase()]);
  if (override && typeof override === 'object') {
    const prompt = Number(override.prompt);
    const completion = Number(override.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      return {
        id: String(override.id || 'custom/' + normalizeModel(raw)),
        price: {
          prompt,
          completion,
          cacheRead: Number.isFinite(Number(override.cacheRead)) ? Number(override.cacheRead) : null,
          cacheWrite: Number.isFinite(Number(override.cacheWrite)) ? Number(override.cacheWrite) : null,
          cacheWrite1h: Number.isFinite(Number(override.cacheWrite1h)) ? Number(override.cacheWrite1h) : null
        }
      };
    }
  }
  const requested = typeof override === 'string' ? override : raw;
  const normalized = normalizeModel(requested);
  const dotted = normalized.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  const candidates = [normalized, dotted];

  for (const candidate of candidates) {
    const id = snapshot.models[candidate]
      ? candidate
      : snapshot.aliases[candidate];
    if (id && snapshot.models[id]) return { id, price: snapshot.models[id] };
  }

  const ids = Object.keys(snapshot.models);
  for (const candidate of candidates) {
    const matches = ids.filter((key) => key.endsWith('/' + candidate));
    if (matches.length === 1) return { id: matches[0], price: snapshot.models[matches[0]] };
  }
  return null;
}

/** @param {object} base @param {number} promptTokens @returns {object} */
function tierFor(base, promptTokens) {
  if (!Array.isArray(base.overrides)) return base;
  let selected = null;
  for (const candidate of base.overrides) {
    if (Number.isFinite(candidate.minPromptTokens) && promptTokens >= candidate.minPromptTokens) {
      if (!selected || candidate.minPromptTokens > selected.minPromptTokens) selected = candidate;
    }
  }
  return selected ? Object.assign({}, base, selected, { overrides: base.overrides }) : base;
}

/**
 * Price one token fact bag.
 *
 * `unattributed` is used only when a source exposes a total without an
 * input/output split (currently Grok Build logs). It is priced with the
 * snapshot's documented input-heavy ratio and marked partial, never presented
 * as an exact bill or silently valued at zero.
 *
 * @param {string|null} model
 * @param {object} tokens
 * @param {object} [options]
 * @returns {{version:string,model:string|null,status:'priced'|'partial'|'unknown',amount:number|null,flatAmount:number|null,unattributedTokens:number}}
 */
/**
 * Split cache-write tokens into five-minute, one-hour, and residual buckets.
 *
 * Duration fields are optional. Older events only carry aggregate `cache_write`
 * and continue to price that aggregate at the five-minute `cacheWrite` rate so
 * historical totals stay stable. When Anthropic (or a proxy) supplies a
 * duration split, five-minute writes use `cacheWrite` and one-hour writes use
 * `cacheWrite1h`.
 *
 * Invariant: paid duration tokens never exceed aggregate `cache_write`. When
 * 5m+1h (or either alone) exceeds the aggregate, paid duration is capped to
 * the aggregate and the excess is marked unpriced/partial rather than
 * overbilling or inventing a duration. Residual aggregate without duration
 * (or a one-hour write without a catalogue `cacheWrite1h` rate) is also left
 * out of the dollar total and marked partial.
 *
 * @param {object} tokens
 * @returns {{fiveMinute:number,oneHour:number,legacyAggregate:number,unpricedWrite:number}}
 */
function splitCacheWriteTokens(tokens) {
  const t = tokens || {};
  const total = count(t.cache_write != null ? t.cache_write : t.cacheWrite);
  const fiveRaw = count(t.cache_write_5m != null ? t.cache_write_5m : t.cacheWrite5m);
  const oneHourRaw = count(t.cache_write_1h != null ? t.cache_write_1h : t.cacheWrite1h);
  // Tokens whose duration was known but could not be applied to this event's
  // aggregate (progressive cap / pure-legacy growth after a duration sighting).
  // They must not inflate `total` or be billed again — only mark partial.
  const unresolved = count(
    t.cache_write_unresolved != null ? t.cache_write_unresolved : t.cacheWriteUnresolved
  );

  if (!fiveRaw && !oneHourRaw) {
    return {
      fiveMinute: 0,
      oneHour: 0,
      legacyAggregate: total,
      unpricedWrite: unresolved
    };
  }

  // Cap each duration field and their sum to the aggregate. Five-minute is
  // allocated first; one-hour receives the remaining aggregate capacity.
  const fiveMinute = Math.min(fiveRaw, total);
  const oneHour = Math.min(oneHourRaw, Math.max(0, total - fiveMinute));
  const paidDuration = fiveMinute + oneHour;
  const residual = Math.max(0, total - paidDuration);
  const overflow = Math.max(0, fiveRaw + oneHourRaw - paidDuration);
  return {
    fiveMinute,
    oneHour,
    legacyAggregate: 0,
    unpricedWrite: residual + overflow + unresolved
  };
}

function priceTokens(model, tokens, options) {
  const found = resolve(model, options && options.overrides);
  const t = tokens || {};
  const freshIn = count(t.in);
  const out = count(t.out);
  const cacheRead = count(t.cache_read != null ? t.cache_read : t.cacheRead);
  const cacheWrite = count(t.cache_write != null ? t.cache_write : t.cacheWrite);
  const unattributed = count(t.unattributed != null ? t.unattributed : t.unknown);
  const missing = Array.isArray(t.missing) ? t.missing.filter((name) => typeof name === 'string') : [];
  const writeSplit = splitCacheWriteTokens(t);

  if (!found || !Number.isFinite(found.price.prompt) || !Number.isFinite(found.price.completion)) {
    return {
      version: snapshot.version,
      model: null,
      status: 'unknown',
      amount: null,
      flatAmount: null,
      unattributedTokens: unattributed
    };
  }

  const promptTokens = freshIn + cacheRead + cacheWrite;
  const p = tierFor(found.price, promptTokens);
  const cacheReadRate = Number.isFinite(p.cacheRead) ? p.cacheRead : 0.1 * p.prompt;
  const cacheWriteRate = Number.isFinite(p.cacheWrite) ? p.cacheWrite : 1.25 * p.prompt;
  const cacheWrite1hRate = Number.isFinite(p.cacheWrite1h) ? p.cacheWrite1h : null;
  const inputRatio = Number(snapshot.unattributedInputRatio) || 0.8;
  const blended = inputRatio * p.prompt + (1 - inputRatio) * p.completion;

  let writeAmount = writeSplit.legacyAggregate * cacheWriteRate
    + writeSplit.fiveMinute * cacheWriteRate;
  let unpricedWrite = writeSplit.unpricedWrite;
  if (writeSplit.oneHour) {
    if (cacheWrite1hRate == null) unpricedWrite += writeSplit.oneHour;
    else writeAmount += writeSplit.oneHour * cacheWrite1hRate;
  }

  const amount = freshIn * p.prompt + out * p.completion
    + cacheRead * cacheReadRate + writeAmount
    + unattributed * blended;
  const flatAmount = (freshIn + cacheRead + cacheWrite) * p.prompt
    + out * p.completion + unattributed * blended;
  const partial = Boolean(unattributed || unpricedWrite || missing.length);

  return {
    version: snapshot.version,
    model: found.id,
    status: partial ? 'partial' : 'priced',
    amount,
    flatAmount,
    unattributedTokens: unattributed,
    unpricedCacheWriteTokens: unpricedWrite
  };
}

/** @returns {object} a copy safe for callers to inspect */
function catalogue() {
  return {
    version: snapshot.version,
    asOf: snapshot.asOf,
    source: snapshot.source,
    modelCount: snapshot.modelCount || Object.keys(snapshot.models).length,
    map: Object.assign({}, snapshot.models)
  };
}

module.exports = {
  snapshot, catalogue, resolve, priceTokens, normalizeModel, tierFor, splitCacheWriteTokens
};
