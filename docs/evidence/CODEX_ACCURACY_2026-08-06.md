# Codex subscription accuracy proof — 2026-08-06

This artifact pins one real, controlled Codex subscription workload and traces its sanitized native counters through the private Usage Panel. It contains no authentication material, prompt history beyond the public probe text, or completion history beyond the public probe response.

The corrected work is based directly on project commit `c04c1ec3512da5f226281dafd6eb6dc3a5074ee9`. It does not merge or fast-forward the stale accuracy branch. The baseline's accounts, rate limits, schema migrations 004–006, readiness checks, deployment files, and duration-aware Claude cache-write pricing remain present.

## Controlled workload

Command:

```text
timeout 30 codex exec --json --ignore-user-config --model gpt-5.6-sol --sandbox read-only --skip-git-repo-check -C /tmp/codex-accuracy-probe "Without using tools, reply with exactly: USAGE_PANEL_CODEX_PROBE_20260806"
```

Sanitized output:

```json
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"USAGE_PANEL_CODEX_PROBE_20260806"}}
{"type":"turn.completed","usage":{"input_tokens":19608,"cached_input_tokens":3712,"cache_write_input_tokens":0,"output_tokens":15,"reasoning_output_tokens":0}}
```

The command also warned that local metadata for `gpt-5.6-sol` was unavailable under `--ignore-user-config`; the native model context still recorded the requested and served model as `gpt-5.6-sol`. The original private log was independently replayed during review. Its path and identifiers are intentionally absent from this public-facing artifact.

The committed allowlisted fixture is a deterministic projection of that reviewed log. It contains only synthetic timestamps, model context, and the five native token counters needed by the proof. It contains no session identifier, account window, plan, reset, working directory, or rate-limit metadata:

```text
scripts/fixtures/codex-real-probe-2026-08-06.jsonl
SHA-256 55f6906fa376d5776e75ac14e161c6762ca5898e652402a1ff454f7f83a46df2
```

## Exact counter reconciliation

Codex reports `input_tokens` inclusive of cache reads and cache writes. The panel stores mutually exclusive buckets:

| Fact | Native | Panel event | Difference |
|---|---:|---:|---:|
| Model | `gpt-5.6-sol` | `gpt-5.6-sol` | exact |
| Input, inclusive | 19,608 | — | — |
| Fresh input | `19,608 - 3,712 - 0 = 15,896` | 15,896 | 0 |
| Output | 15 | 15 | 0 |
| Cache read | 3,712 | 3,712 | 0 |
| Cache write | 0 | 0 | 0 |
| Reasoning output | 0 | 0 | 0 |

The PostgreSQL/HTTP regression reads the committed native fixture through the Codex log parser, queues and uploads the resulting event, checks the stored PostgreSQL row, and checks the manager fleet aggregates. The model and all four token buckets remain unchanged at every boundary.

## OpenRouter-equivalent estimate

Catalogue:

```text
version: openrouter-2026-08-03
as of: 2026-08-03T23:10:14.912Z
model: openai/gpt-5.6-sol
snapshot SHA-256: e61a9fd34be8e98d0b1b2f822197845229387ee745f2a4dfb73e4a75342a378a
```

Calculation from the snapshot's per-token rates:

```text
fresh input  15,896 × $0.00000500 = $0.079480
output           15 × $0.00003000 = $0.000450
cache read    3,712 × $0.00000050 = $0.001856
cache write       0 × $0.00000625 = $0.000000
                                      ---------
OpenRouter-equivalent estimate         $0.081786
full-input sticker comparison          $0.098490
```

This is an API-price equivalent, not subscription spend and not an amount charged.

## Preserved Claude one-hour pricing regression

The current baseline's duration-aware Claude proof remains in the full suite. For the real-shaped `claude-haiku-4-5` case with 10 input, 58 output, and 6,440 one-hour cache-write tokens:

```text
10 × $0.00000100 + 58 × $0.00000500 + 6,440 × $0.00000200 = $0.013180
```

The tests assert `$0.01318`, preserve `cache_write_1h=6440` through upload and storage, and would reject the stale aggregate-only `$0.00835` result.

## Honest scope labels

- Task counters: `exact` for this workload because all four native fields are present, including the explicit zero cache-write field.
- Model identity: `exact` because the native `turn_context` names `gpt-5.6-sol`.
- Independent provider event: `unknown`; the subscription-native surfaces used here expose no independently matchable per-event provider ledger.
- Account/window: omitted from the public fixture because it is unrelated to per-event validation. The manager view does not ingest account/window snapshots and labels that figure `unknown`.
- Older Codex rows without `cache_write_input_tokens`: `partial`, with `cache_write` listed as an unknown token category; their known-token estimate is never labelled exact.
- Rows without a native model: model `unknown`, no fallback pricing model, and estimate `unknown`.

## Reproduction

Sanitized counter and pricing proof:

```text
npm run accuracy:codex
```

Full package suite against a disposable local PostgreSQL database:

```text
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:34864/usage_panel_accuracy \
NODE_PATH=/path/to/node_modules \
npm test
```

Observed suite summary from this corrected worktree:

```text
25 capture proxy passed
23 event store passed
10 adapters passed
24 local usage and pricing passed
27 PostgreSQL security/sync passed
17 manager dashboard passed
10 end-user accounts passed
5 offline operations passed
6 compose/dependency isolation passed
14 client-release packaging passed
Total: 161 passed, 0 failed
```

No public route, deployment, production database write, Super ZT login change, or secret output was involved.
