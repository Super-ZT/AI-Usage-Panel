'use strict';

/**
 * Harness registry — declarative signatures for every supported tool.
 *
 * Detection is data, not code: adding support for a new harness means adding an
 * entry here, and every machine then discovers it automatically. Nothing in
 * this file is specific to one user or one installation.
 *
 * Field reference
 *   id            stable key used in events and the UI
 *   label         display name
 *   bins          executable names to look for on PATH
 *   homes         candidate data directories; `~` and $ENV are expanded
 *   envHome       environment variable that overrides the home directory
 *   marker        file that must exist inside a home directory to confirm it
 *   quota         how subscription quota is obtained: 'official' | null
 *   tokens        where token counts come from: 'logs' | 'proxy' | 'server-api' | 'none'
 *   byok          true when the tool calls providers with the user's own key,
 *                 in which case the capture proxy is the source of truth
 *   baseUrlEnv    environment variables that redirect it at the proxy
 *   notes         shown in the UI when manual steps are required
 */

/** @typedef {{id:string,label:string,bins:string[],homes:string[],envHome?:string,marker?:string,quota:string|null,tokens:string,byok:boolean,baseUrlEnv?:string[],configHint?:string,notes?:string}} HarnessSignature */

/** @type {HarnessSignature[]} */
const HARNESSES = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    bins: ['claude'],
    envHome: 'CLAUDE_CONFIG_DIR',
    homes: ['~/.claude'],
    marker: 'projects',
    quota: 'official',
    tokens: 'logs',
    byok: false,
    notes: 'Subscription quota from the OAuth usage endpoint; token counts from local transcripts.'
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    bins: ['codex'],
    envHome: 'CODEX_HOME',
    homes: ['~/.codex'],
    marker: 'sessions',
    quota: 'official',
    tokens: 'logs',
    byok: false,
    notes: 'Account-wide quota from the ChatGPT backend. Local logs cover this machine only.'
  },
  {
    id: 'grok-build',
    label: 'Grok Build',
    bins: ['grok'],
    envHome: 'GROK_HOME',
    homes: ['~/.grok'],
    marker: 'auth.json',
    quota: 'official',
    tokens: 'logs',
    byok: false,
    notes: 'SuperGrok plan quota from the billing endpoint.'
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    bins: ['gemini'],
    envHome: 'GEMINI_CONFIG_DIR',
    homes: ['~/.gemini'],
    quota: null,
    tokens: 'proxy',
    byok: true,
    baseUrlEnv: ['GOOGLE_GEMINI_BASE_URL'],
    notes: 'Route through the capture proxy to record model and tokens.'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    bins: ['kimi'],
    homes: ['~/.kimi', '~/.kimi-code'],
    quota: null,
    tokens: 'proxy',
    byok: true,
    baseUrlEnv: ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'],
    notes: 'Anthropic/OpenAI-compatible; capture via the proxy.'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bins: ['opencode'],
    homes: ['~/.local/share/opencode', '~/.config/opencode'],
    quota: null,
    tokens: 'proxy',
    byok: true,
    baseUrlEnv: ['OPENAI_BASE_URL'],
    configHint: 'opencode.json → provider.<name>.options.baseURL',
    notes: 'Routes through whichever provider is configured; the served model is only visible on the wire.'
  },
  {
    id: 'pi',
    label: 'pi (Sakana)',
    bins: ['pi'],
    homes: ['~/.pi'],
    quota: null,
    tokens: 'proxy',
    byok: true,
    baseUrlEnv: ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
    notes: 'Model is chosen per invocation (--provider/--model), so only the wire is authoritative.'
  },
  {
    id: 'coderabbit',
    label: 'CodeRabbit',
    bins: ['coderabbit'],
    homes: ['~/.coderabbit'],
    quota: null,
    tokens: 'proxy',
    byok: true,
    baseUrlEnv: ['OPENAI_BASE_URL'],
    notes: 'Capture via the proxy; no local usage log.'
  },
  {
    id: 'hermes',
    label: 'Hermes',
    bins: ['hermes'],
    envHome: 'HERMES_HOME',
    homes: ['~/.hermes'],
    quota: null,
    tokens: 'proxy',
    byok: true,
    baseUrlEnv: ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'],
    notes: 'Multi-provider agent runtime; the proxy records whichever model each run selects.'
  },
  {
    id: 'agent-zero',
    label: 'Agent Zero',
    bins: ['a0', 'agent-zero'],
    homes: ['~/.agent-zero'],
    quota: null,
    tokens: 'server-api',
    byok: true,
    notes: 'Runs as a server (default http://localhost:5080). Usage lives in that instance, so the proxy only sees traffic if the server itself is pointed at it.'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    bins: ['cursor'],
    homes: ['~/.cursor'],
    quota: null,
    tokens: 'none',
    byok: false,
    notes: 'Talks to Cursor\'s own backend with pinned auth — not proxyable. Usage is only available from the Cursor dashboard.'
  }
];

/** @returns {HarnessSignature[]} a copy, so callers cannot mutate the registry */
function all() {
  return HARNESSES.map((h) => Object.assign({}, h));
}

/** @param {string} id @returns {HarnessSignature|null} */
function byId(id) {
  const found = HARNESSES.find((h) => h.id === id);
  return found ? Object.assign({}, found) : null;
}

module.exports = { HARNESSES, all, byId };
