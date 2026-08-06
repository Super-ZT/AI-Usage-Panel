'use strict';

/**
 * Registry of upstream LLM providers the capture proxy can forward to.
 *
 * `basePath` is prefixed to the path the client requested, so a harness
 * configured with a base URL of `<proxy>/<harness>/<provider>/v1` sends
 * `/v1/chat/completions` and OpenRouter receives `/api/v1/chat/completions`.
 *
 * `dialect` selects how usage is parsed out of the response (see capture.js).
 */

/** @typedef {{host:string, port:number|null, protocol:'http:'|'https:', basePath:string, dialect:'openai'|'anthropic'|'gemini', label:string}} Upstream */

/** @type {Record<string, Upstream>} */
const BUILT_IN = {
  openrouter: { host: 'openrouter.ai', port: null, protocol: 'https:', basePath: '/api', dialect: 'openai', label: 'OpenRouter' },
  openai: { host: 'api.openai.com', port: null, protocol: 'https:', basePath: '', dialect: 'openai', label: 'OpenAI' },
  anthropic: { host: 'api.anthropic.com', port: null, protocol: 'https:', basePath: '', dialect: 'anthropic', label: 'Anthropic' },
  xai: { host: 'api.x.ai', port: null, protocol: 'https:', basePath: '', dialect: 'openai', label: 'xAI' },
  groq: { host: 'api.groq.com', port: null, protocol: 'https:', basePath: '/openai', dialect: 'openai', label: 'Groq' },
  deepseek: { host: 'api.deepseek.com', port: null, protocol: 'https:', basePath: '', dialect: 'openai', label: 'DeepSeek' },
  moonshot: { host: 'api.moonshot.ai', port: null, protocol: 'https:', basePath: '', dialect: 'openai', label: 'Moonshot' },
  google: { host: 'generativelanguage.googleapis.com', port: null, protocol: 'https:', basePath: '', dialect: 'gemini', label: 'Google' },
  // Self-hosted runtimes: local, plaintext, OpenAI-compatible.
  ollama: { host: '127.0.0.1', port: 11434, protocol: 'http:', basePath: '', dialect: 'openai', label: 'Ollama' },
  lmstudio: { host: '127.0.0.1', port: 1234, protocol: 'http:', basePath: '', dialect: 'openai', label: 'LM Studio' },
  vllm: { host: '127.0.0.1', port: 8000, protocol: 'http:', basePath: '', dialect: 'openai', label: 'vLLM' }
};

/**
 * Resolve a provider key to an upstream definition.
 * Custom providers may be supplied via config using the same shape.
 *
 * @param {string} key provider key from the request path
 * @param {Record<string, Partial<Upstream>>} [custom] user-defined providers
 * @returns {Upstream|null}
 */
function resolveUpstream(key, custom) {
  if (!key) return null;
  const normalized = String(key).toLowerCase();
  // hasOwnProperty guards against inherited keys: a path segment of
  // "constructor" would otherwise resolve to a truthy Object member and
  // produce an upstream with host undefined — which http.request turns into a
  // call to localhost carrying the client's credentials.
  const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);
  if (has(custom, normalized)) {
    const c = custom[normalized];
    // A custom provider may be declared either as a full `baseUrl` or as
    // discrete host/port/protocol fields.
    if (c.baseUrl) {
      let parsed;
      try { parsed = new URL(c.baseUrl); } catch (_) { return null; }
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : null,
        protocol: parsed.protocol === 'http:' ? 'http:' : 'https:',
        basePath: parsed.pathname.replace(/\/$/, ''),
        dialect: c.dialect || 'openai',
        label: c.label || normalized
      };
    }
    if (!c.host) return null;
    return {
      host: c.host,
      port: c.port != null ? Number(c.port) : null,
      protocol: c.protocol === 'http:' || c.protocol === 'http' ? 'http:' : 'https:',
      basePath: c.basePath || '',
      dialect: c.dialect || 'openai',
      label: c.label || normalized
    };
  }
  return has(BUILT_IN, normalized) ? BUILT_IN[normalized] : null;
}

/** @returns {string[]} keys of all built-in providers */
function builtInKeys() {
  return Object.keys(BUILT_IN);
}

module.exports = { BUILT_IN, resolveUpstream, builtInKeys };
