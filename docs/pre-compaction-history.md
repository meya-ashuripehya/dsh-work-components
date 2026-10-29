# Pre-compaction history (`search_pre_compaction`)

## Problem
Official DSH compaction (`/compact` or auto pressure) replaces a surface span with a `user/message` whose `source.kind === 'compact-checkpoint'` and `surfaceOp.op === 'replace'`. After that, `deriveMessages()` only sees the summary checkpoint; the model cannot read the original turns.

## Mechanism (verified against `@deepseek-ai/dsh-compaction*` / session surface)
- Session log is **append-only** (`~/.dsh/sessions/**/session.v4.jsonl.zstd`). Raw events are **not deleted**.
- Compaction timeline: `compaction/start` → `compaction/summary` → surface `replace` checkpoint → `compaction/end`.
- Shadowed append-origin events (`surfaceOp === 'append'`) stay in the log; only the live surface drops them.
- Live read path for tools: `exec.session.snapshotEvents()` (same events as the zstd log).

## Feature
- Setting: `preCompactionHistoryEnabled` (default **true**). Chinese UI card: **压缩前历史**.
- Tool (English name): `search_pre_compaction`
  - `listCheckpoints=true` — list compact-checkpoint ranges + summary preview
  - `query` — case-insensitive multi-term substring over shadowed bodies (CJK OK)
  - filters: `role`, `fromSeq`, `toSeq`, `compactionId`, `context` (0–3), `limit` (1–20)
- Owner-gate: tool is in Telegram `OPEN_TOOLS` (same class as `search_history`).
- Scope: **current session only**, read-only. Unrelated to chatroom `search_history` (`messages.jsonl`).

## Files
| Path | Role |
|------|------|
| `src/session-history/extract.mjs` | Corpus + search |
| `src/session-history/tools.mjs` | `defineTool` |
| `src/session-history/index.mjs` | Feature mount/sync/dispose |
| `src/session-history/extract.test.mjs` | Unit tests |
| `src/index.mjs` | Schema + create/sync/dispose |
| `src/channels/telegram/owner-gate.mjs` | OPEN_TOOLS |
| `lib/client.js` | INPUT_FIELDS + FEATURES card |

Backup of pre-edit wiring: `.bak-pre-compaction-history-20261028-044118` (path also in `tmp-backup-path-pre-compaction.txt`).

## Smoke
Live session `session-f0476002-7973-4886-9af1-caca27276c14`: 1 checkpoint, 938 recoverable append entries, keyword search returns hits.

## Open questions / follow-ups
1. Cross-session variant (read another session’s shadowed log) — not in MVP; would need owner policy.
2. Whether to also expose `read_pre_compaction` by exact `seq` (today: `fromSeq`/`toSeq` + query covers it).
3. Token budget: tool caps body length and hit count; very large shadowed ranges still need targeted queries.
4. Re-compaction stacking: later checkpoints re-attribute overlapping seqs to the newest checkpoint (implemented).

## Related
Companion agents: see [companion-compaction.md](./companion-compaction.md) for overriding the official coding-assistant compaction *instruction* (summarizer prompt). Raw log recovery via `search_pre_compaction` is unchanged.
