# Companion compaction instruction override

## Problem
Official `@deepseek-ai/dsh-compaction-basic` freezes `COMPACTION_INSTRUCTION` as an English **coding-assistant** checkpoint (`Primary Request`, `Files and Code`, `Errors and Fixes`, …). It is appended as the last user message when `purpose: "compaction"`. The instruction is not configurable; cordis config rejects unknown fields. For companion / 陪伴 agents (LingSnow etc.) that structure is wrong.

## Mechanism
Workbench wraps `ctx.llm.stream` at runtime (idempotent). When `options.purpose === 'compaction'` and the setting is on, the **last user message** is replaced with a new message object whose text is the companion instruction (built-in Chinese checkpoint, or a non-empty custom string). Original deepFrozen content is not mutated. Non-compaction streams are untouched. On dispose / disable, the original `stream` is restored.

Does **not** modify Program Files or the `@deepseek-ai/dsh-compaction-basic` package on disk.

## Settings
| Key | Default | Meaning |
|-----|---------|---------|
| `companionCompactionEnabled` | `true` (missing → on) | Install the stream wrap |
| `companionCompactionInstruction` | `''` | Non-empty multiline → use instead of built-in |

Chinese UI card under **通用**: **陪伴压缩指令** (adjacent to **压缩前历史**).

## Relationship to pre-compaction history
Independent. Official compaction still writes `compact-checkpoint` / shadows the surface; session append log keeps raw turns; `search_pre_compaction` still works when `preCompactionHistoryEnabled` is on. This feature only changes **what the summarizer is asked to write**.

## Files
| Path | Role |
|------|------|
| `src/session-history/companion-instruction.mjs` | Built-in `COMPANION_COMPACTION_INSTRUCTION` |
| `src/session-history/companion-compaction.mjs` | Rewrite helpers + feature mount/sync/dispose |
| `src/session-history/companion-compaction.test.mjs` | Unit tests (pure helpers) |
| `src/session-history/index.mjs` | Re-exports companion feature |
| `src/index.mjs` | Schema + create/sync/dispose |
| `lib/client.js` | INPUT_FIELDS + FEATURES card |

## Smoke
```bash
node --test src/session-history/companion-compaction.test.mjs
```
