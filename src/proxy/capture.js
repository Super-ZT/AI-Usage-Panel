'use strict';

/**
 * Extraction of model identity and token usage from LLM API traffic.
 *
 * Pure functions only — no I/O, no network — so the dialect handling can be
 * unit-tested offline. Every provider reports usage in a different shape and
 * streaming responses report it in a different place again; this module
 * normalises all of them to one structure:
 *
 *   { in, out, cacheRead, cacheWrite, reasoning }
 *
 * `in` is always *fresh* (non-cached) input where the provider distinguishes
 * it, so callers can price cached and uncached input separately.
 */

/** @typedef {{in:number,out:number,cacheRead:number,cacheWrite:number,cacheWrite5m:number,cacheWrite1h:number,reasoning:number}} Usage */

const ZERO = Object.freeze({
  in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0
});

/** @param {*} v @returns {number} */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Normalise any provider's usage object into the common shape.
 *
 * Recognises OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and
 * Google Gemini. Returns null when the object carries no usage information, so
 * callers can distinguish "no usage reported" from "zero tokens used".
 *
 * @param {any} usage raw usage object from a provider payload
 * @returns {Usage|null}
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  // --- Anthropic Messages -------------------------------------------------
  // input_tokens already excludes cached reads, so no subtraction is needed.
  // When cache_creation splits five-minute vs one-hour TTL, preserve both so
  // pricing can apply cacheWrite vs cacheWrite1h instead of collapsing to 5m.
  if ('cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage
      || (usage.cache_creation && typeof usage.cache_creation === 'object')) {
    const creation = usage.cache_creation && typeof usage.cache_creation === 'object'
      ? usage.cache_creation
      : null;
    const five = creation ? num(creation.ephemeral_5m_input_tokens) : 0;
    const oneHour = creation ? num(creation.ephemeral_1h_input_tokens) : 0;
    const aggregate = num(usage.cache_creation_input_tokens);
    return {
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: aggregate || (five + oneHour),
      cacheWrite5m: five,
      cacheWrite1h: oneHour,
      reasoning: 0
    };
  }

  // --- OpenAI Responses API ----------------------------------------------
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    const cached = num(usage.input_tokens_details && usage.input_tokens_details.cached_tokens);
    return {
      in: Math.max(0, num(usage.input_tokens) - cached), // input_tokens is inclusive of cached
      out: num(usage.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      reasoning: num(usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens)
    };
  }

  // --- OpenAI Chat Completions -------------------------------------------
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    const cached = num(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
    return {
      in: Math.max(0, num(usage.prompt_tokens) - cached), // prompt_tokens is inclusive of cached
      out: num(usage.completion_tokens),
      cacheRead: cached,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      reasoning: num(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens)
    };
  }

  // --- Google Gemini ------------------------------------------------------
  if ('promptTokenCount' in usage || 'candidatesTokenCount' in usage) {
    const cached = num(usage.cachedContentTokenCount);
    return {
      // Tool-use prompt tokens are billed as input but reported separately.
      in: Math.max(0, num(usage.promptTokenCount) - cached) + num(usage.toolUsePromptTokenCount),
      out: num(usage.candidatesTokenCount),
      cacheRead: cached,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      reasoning: num(usage.thoughtsTokenCount)
    };
  }

  // --- Ollama / llama.cpp native ------------------------------------------
  if ('prompt_eval_count' in usage || 'eval_count' in usage) {
    return {
      in: num(usage.prompt_eval_count),
      out: num(usage.eval_count),
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      reasoning: 0
    };
  }

  return null;
}

/**
 * Locate a usage object anywhere in a decoded response body.
 * Providers nest it differently (`usage`, `response.usage`, `usageMetadata`).
 *
 * @param {any} body decoded JSON body
 * @returns {Usage|null}
 */
function usageFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  return normalizeUsage(body.usage)
    || normalizeUsage(body.usageMetadata)
    || normalizeUsage(body.response && body.response.usage)
    || normalizeUsage(body.message && body.message.usage)
    || null;
}

/**
 * Extract the model identifier from a decoded payload.
 * @param {any} body
 * @returns {string|null}
 */
function modelFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.model === 'string' && body.model) return body.model;
  if (body.response && typeof body.response.model === 'string') return body.response.model;
  if (body.message && typeof body.message.model === 'string') return body.message.model;
  // Gemini reports the served model here on streaming responses
  if (typeof body.modelVersion === 'string' && body.modelVersion) return body.modelVersion;
  return null;
}

/** @param {Usage|null} a @param {Usage|null} b @returns {Usage|null} */
function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    // Later frames restate cumulative totals rather than deltas, so take the
    // larger value per field instead of summing (which would double-count).
    in: Math.max(a.in, b.in),
    out: Math.max(a.out, b.out),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheWrite5m: Math.max(a.cacheWrite5m || 0, b.cacheWrite5m || 0),
    cacheWrite1h: Math.max(a.cacheWrite1h || 0, b.cacheWrite1h || 0),
    reasoning: Math.max(a.reasoning, b.reasoning)
  };
}

/**
 * Incremental reader for a streaming (SSE or JSON-lines) response body.
 *
 * Streaming responses report usage in their final frames, and each dialect puts
 * it somewhere different:
 *   - OpenAI      final `data:` chunk (only when stream_options.include_usage)
 *   - Anthropic   `message_start` (input/cache) then `message_delta` (output)
 *   - Gemini      `usageMetadata` on the terminal chunk
 *
 * Feed raw response bytes with {@link push}; the accumulator tolerates frames
 * split across chunk boundaries.
 */
class StreamCapture {
  constructor() {
    /** @private */ this._buffer = '';
    /** @private */ this._usage = null;
    /** @private */ this._model = null;
    /** @private */ this._bytes = 0;
  }

  /**
   * Feed a chunk of the response body.
   * Never throws: malformed frames are skipped so capture can't break a stream.
   * @param {Buffer|string} chunk
   */
  push(chunk) {
    try {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this._bytes += Buffer.byteLength(text);
      this._buffer += text;

      // Process complete lines only; retain any trailing partial line.
      const lines = this._buffer.split(/\r?\n/);
      this._buffer = lines.pop() || '';

      for (const line of lines) this._consumeLine(line);

      // Guard against unbounded growth if a peer never emits newlines.
      if (this._buffer.length > 1024 * 1024) this._buffer = this._buffer.slice(-4096);
    } catch (_) { /* capture must never disturb the proxied stream */ }
  }

  /** @private @param {string} line */
  _consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // SSE payload lines are `data: {...}`; JSON-lines dialects send bare JSON.
    let payload = trimmed;
    if (payload.startsWith('data:')) payload = payload.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    if (payload[0] !== '{' && payload[0] !== '[') return;

    let parsed;
    try { parsed = JSON.parse(payload); } catch (_) { return; }

    const frames = Array.isArray(parsed) ? parsed : [parsed];
    for (const frame of frames) {
      const model = modelFromBody(frame);
      if (model) this._model = model;
      this._usage = mergeUsage(this._usage, usageFromBody(frame));
    }
  }

  /**
   * Finalise and return what was observed.
   * @returns {{model:string|null, usage:Usage|null, bytes:number}}
   */
  result() {
    if (this._buffer.trim()) {
      // Flush a final frame that arrived without a trailing newline.
      const pending = this._buffer;
      this._buffer = '';
      this._consumeLine(pending);
    }
    return { model: this._model, usage: this._usage, bytes: this._bytes };
  }
}

/**
 * Ensure an OpenAI-compatible streaming request asks for usage in its final
 * chunk. Without `stream_options.include_usage` the provider omits usage
 * entirely and the request becomes unaccountable.
 *
 * Returns the original buffer unchanged if the body is not JSON, is not a
 * stream, or already sets the option — mutation is a last resort, never a
 * default rewrite.
 *
 * @param {Buffer} body raw request body
 * @param {'openai'|'anthropic'|'gemini'|'unknown'} dialect
 * @returns {{body:Buffer, modified:boolean}}
 */
function ensureUsageReporting(body, dialect) {
  if (dialect !== 'openai' || !body || !body.length) return { body, modified: false };
  const text = body.toString('utf8');

  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return { body, modified: false }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { body, modified: false };
  if (parsed.stream !== true) return { body, modified: false };
  if (parsed.stream_options && parsed.stream_options.include_usage) return { body, modified: false };
  // Only an absent stream_options can be spliced safely; anything else would
  // require rewriting the caller's object.
  if (parsed.stream_options != null) return { body, modified: false };

  // Splice textually rather than re-serialising. A JSON round-trip silently
  // rounds integers beyond 2^53 (seeds, tool-result ids), which would change
  // the request the caller actually made.
  const end = text.lastIndexOf('}');
  if (end === -1) return { body, modified: false };
  const head = text.slice(0, end);
  const tail = text.slice(end);
  const separator = /[^\s{]\s*$/.test(head) ? ',' : '';
  const injected = head + separator + '"stream_options":{"include_usage":true}' + tail;

  // Re-parse as a safety net: never forward a body we just made invalid.
  try { JSON.parse(injected); } catch (_) { return { body, modified: false }; }
  return { body: Buffer.from(injected, 'utf8'), modified: true };
}

module.exports = {
  ZERO,
  normalizeUsage,
  usageFromBody,
  modelFromBody,
  mergeUsage,
  StreamCapture,
  ensureUsageReporting
};
