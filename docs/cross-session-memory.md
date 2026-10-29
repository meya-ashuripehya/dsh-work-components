# Cross-session memory / history (design)

> Status: **v0 tools shipped** + **person-profile slice (2026-10-25)**: OwnerLink defaults, alias map UI, display-name priority, capped `[person-memory]` inbound summary.  
> Repo: `S:\TRIX\dsh-workbench` (`dsh-work-components`). Machine: Ashuripehya.  
> Date: 2026-10-25 (America/New_York). **No commit.**  
> Related: `docs/qq-channel-component.md`, chatroom `search_history` (`src/chatroom/history-search.mjs`), harness bindings (`vendor/wsz987/channel-harness`), session log helpers (`src/session-controls/zstd-log.mjs`), notes tools (`src/notes/tools.mjs`).  
> Code: `src/channels/cross-session-memory.mjs`, `cross-session-tools.mjs`, `cross-session-feature.mjs`, `person-profile.mjs`, `person-memory-inject.mjs`.

---

## 0. Why this exists

Shiro talks to the same persona (e.g. **lingsnow** / DeepSeek) over **QQ DM**, **Telegram DM/groups**, **desktop sessions**, and **聊天室 (中转站)**. Today each binding owns an isolated DSH session transcript. The model in one session cannot see what happened in another, so continuity across apps is lost unless the human re-explains.

Goal: give the agent a **limited, explicit, opt-in tool surface** to peer into **allowed peer sessions** — never a silent dump of all history into the prompt.

---


> **User decision (2026-10-25, scoped memory):** 通道会话都可查询，且按人/群区分。  
> All **channel** sessions (QQ + Telegram) in the Memory Circle are queryable — **not** limited to the owner DM pair. List/search results **must** distinguish **person vs group** (and by peer / conversation id). `shareGroups` defaults to **true**. Chatroom early access and auto-inject remain out of scope for v0.

## 1. Goals / non-goals

### Goals

1. **Cross-channel continuity** for the same human + same persona: QQ ↔ Telegram ↔ desktop (and, later, selected chatroom seats).
2. **Pull, not push**: history enters context only when the agent calls a tool (or a future UI “pin”), never by auto-injecting foreign transcripts into every turn.
3. **Hard budgets**: every response is capped (hits, chars/tokens, sessions per call, calls per turn).
4. **Fail closed on identity**: if peer linkage is ambiguous or unauthorized, return empty / error — do not guess.
5. **Reuse existing stores** for v0 (bindings + zstd transcripts + chatroom `messages.jsonl`); derived index only when needed.
6. **Fit Shiro’s setup**: `lingsnow` on QQ `main` + Telegram `main`, owner Telegram id `6153059771`, QQ owner OpenID `B4C6E62A8A0919E62678494F20F30530`, chatroom seats using the same preset family.

### Non-goals

- Merging multiple channel conversations into **one** shared session / one transcript file.
- Silent full-history leak into system prompt or compaction summaries.
- Replacing **notes** (`note_*`) — notes = distilled reusable knowledge; this design = raw / near-raw **chat recall**.
- Cross-user memory (other Telegram group members’ private DMs, random QQ strangers).
- Shipping vector DB / embeddings in v0.
- Writing foreign history back into the current session log as forged `user/message` events.
- Auto-syncing chatroom moderator transcripts into channel sessions (opt-in later only).

---

## 2. Current layout (facts this design hangs on)

| Piece | Location / shape |
| --- | --- |
| Bindings | `~\.dsh\dsh-channels\bindings.json` — key `channel:account:conversation[:thread]` → `{ sessionId, route.preset, conversationType, senderId, durability, schemaVersion: 3 }` |
| Channel transcripts | `~\.dsh\sessions\<workspace-encoded>\ch-…\session.v4.jsonl.zstd` (also v3 / plain jsonl). Header carries `agentPreset`. Events include `user/message`, `assistant/message`, `tool/call`, … |
| Channel metadata prefix | Inbound user text often starts with `[channel=qq\|telegram sender=… message=…]` (harness). |
| Access policy | `~\.dsh\dsh-channels\storage\access\policy\v1\{qq\|telegram}\<account>` — `ownerId`, allowlists, group policies. |
| Owner gate | `src/channels/*/owner-gate.mjs` — senderId from adapter, not body; `OPEN_TOOLS` already includes `search_history` and `group_memory`. |
| Chatroom | Own store: `~\.dsh\data\dsh-work-components\chatroom\rooms\<id>\messages.jsonl` + sidebar `guest` DSH session (`room-sessions.mjs`). Room-local `search_history` already exists (token cap 8000, limit ≤20). |
| Notes | `note_browse` / `note_search` / `note_get` / `note_save` — complementary, not a substitute. |
| Empty placeholder | `~\.dsh\channels-memory\` (0 files today) — natural home for v1 derived index. |
| Log reader | `findSessionLogPath` / `readSessionLog` in `src/session-controls/zstd-log.mjs`. |

**Observed Shiro bindings (illustrative):**

- `telegram:main:6153059771` → `ch-113465b2-…` · preset `lingsnow` · dm  
- `qq:main:B4C6E62A8A0919E62678494F20F30530` → `ch-0d68ce84-…` · preset `lingsnow` · dm  
- `telegram:main:-1003435238151` (+ thread `:40`) → other `ch-…` · preset `lingsnow` · group  
- `telegram:chatgpt:6153059771` → separate session · preset `chatgpt` (**not** same persona family by default)

---

## 3. Identity model — who may share with whom

Sharing is decided by a **Memory Circle** (logical set of session ids). A calling session may only read peers inside circles it belongs to.

### 3.1 Circle membership rules (priority, fail closed)

Evaluate peers in this order; first matching rule that **denies** wins over weaker allows.

| Rule | Meaning | Default for Shiro |
| --- | --- | --- |
| **R0 Same session** | Always may “read self” (but tools skip current session id). | — |
| **R1 Explicit allowlist** | Config maps circle id → sessionIds / binding keys. | Optional overrides only |
| **R2 Owner-linked DMs** | Same **logical owner** across channels: Telegram `ownerId` + QQ `ownerOpenId` declared as one **OwnerLink**, plus desktop sessions tagged to that owner. Only `conversationType: dm` (or desktop private). | **On** — link TG `6153059771` ↔ QQ `B4C6E62A…` |
| **R3 Same preset family** | `route.preset` / `agentPreset` equal (e.g. both `lingsnow`). Alone is **not** enough for groups. | Required **together with** R2 or R5 |
| **R4 Channel family** | Optional: restrict peers to `{qq, telegram, desktop}` vs excluding chatroom / other bots. | Include qq+telegram+desktop; **exclude** chatroom until opted in |
| **R5 Explicit group share** | Group / thread sessions join a circle when `shareGroups: true` (default) or when listed in allowlist. Listings always label **person** vs **group** + peer id. | **On** — user decision 2026-10-25: all channel sessions queryable |
| **R6 Chatroom seat** | Seat with preset `lingsnow` may read OwnerLink DM circle **if** `chatroomShare: true`. Reverse (channel → room) separate flag. | **Off** in v0 |

### 3.2 OwnerLink (config sketch)

```yaml
# conceptual — settings key e.g. crossSessionMemory
crossSessionMemory:
  enabled: true
  ownerLinks:
    - id: shiro
      telegramOwnerIds: ["6153059771"]
      qqOwnerOpenIds: ["B4C6E62A8A0919E62678494F20F30530"]
      desktop: "profile-owner"   # all durable desktop sessions under this DSH profile, or explicit session list
      presets: ["lingsnow"]     # persona family that shares
      includeChannels: ["qq", "telegram", "desktop"]
      shareGroups: true   # user decision 2026-10-25: channel groups queryable
      chatroomShare: false
      allowlistSessionIds: []   # optional extra
      denylistSessionIds: []    # always win
```

**Important:** Telegram numeric ids and QQ OpenIDs live in **different namespaces**. Never string-equal them; only an OwnerLink row connects them.

### 3.3 What does *not* share (defaults)

- `telegram:chatgpt:…` vs `lingsnow` (different preset).
- Unbound / ephemeral channel sessions.
- Other people’s DMs outside the circle. Group peers are included when `shareGroups` is true (default); v0 returns transcript lines with harness tokens stripped — finer non-owner speaker redaction is v1+.
- Chatroom thinking.jsonl / tool-result blobs / card full text (same spirit as room `search_history`: titles only for cards).

---

## 4. Access API (agent-facing)

Mirror chatroom `search_history`: **English tool descriptions**, hard caps, read-only, **pull only** (never auto-inject). Register on channel + desktop agents (and later chatroom seats). Add names to `OPEN_TOOLS` for naming consistency — but **authorization for foreign history is OwnerLink + owner-authorized turn**; OPEN_TOOLS alone is insufficient. Non-owner senders: tool denied. Every list/search row must label **person** (dm) vs **group** and include peer / conversation id so QQ↔Telegram recall stays distinguishable.

### 4.1 Tools (v0)

#### `cross_session_list`

Discover peers the current session may read.

| Param | Type | Notes |
| --- | --- | --- |
| `preset` | string? | Filter by preset; default = caller’s preset |
| `channel` | string? | `qq` \| `telegram` \| `desktop` \| `chatroom` |
| `conversationType` | string? | `dm` \| `group` \| `desktop` \| `room` |
| `limit` | int | default 10, **max 20** |

**Returns (bounded):** list of `{ sessionId, channel, account, conversationType, preset, title?, lastActiveAt?, bindingKey? }`. No message bodies.

#### `cross_session_search`

Search / page peer history.

| Param | Type | Notes |
| --- | --- | --- |
| `sessionId` | string? | One peer; omit = search all peers in circle (**still capped**) |
| `query` | string? | Case-insensitive; whitespace = AND terms (CJK OK). Required unless `lastN` or time range set |
| `lastN` | int? | Last N user↔assistant turns, **max 30** |
| `since` / `until` | ISO string? | Time window |
| `role` | string? | `user` \| `assistant` \| `any` (default any; tool/system omitted unless `includeTools`) |
| `includeTools` | bool | default **false** |
| `includeReasoning` | bool | default **false** (never return reasoning blocks by default) |
| `context` | int | Neighbours each side 0–2, default 0 |
| `limit` | int | Hits 1–15, default 6 |

**Hard caps (enforce in code):**

| Cap | Value |
| --- | --- |
| Max sessions touched per call | 4 |
| Max events scanned per session (v0 naive) | 4000 newest |
| Max returned hits | 15 |
| Max chars per hit body | 600 |
| Max result tokens (estimate) | **6000** (stricter than room’s 8000) |
| Max tool calls / turn (both tools) | 3 |
| Deny current `sessionId` | always |

**Return shape:** plain text for the model, same spirit as `search_history`:

```
Peers searched: 2 (qq dm ch-0d68…, telegram dm ch-1134…).
Found 5 hit(s); showing 5 newest first.
> [qq dm · 2026-10-24T…] user: …
  [qq dm · …] assistant: …
---
…
[Result truncated at ~6000 tokens: …]
```

Each hit labeled with **channel + conversationType + short session id**, never raw secrets from metadata prefixes (strip `[channel=… message=TOKEN]` to `[channel=qq sender=owner]`).

### 4.2 Tools (v1+, optional)

| Tool | Purpose |
| --- | --- |
| `cross_session_get_turn` | Fetch one turn by `sessionId` + turn number / seq (still char-capped). |
| `memory_pin` / `memory_list` | User- or agent-pinned facts into `~\.dsh\channels-memory\<circleId>\pins.jsonl` (derived store). |
| UI: “共享记忆” panel | Show circle members, last sync, denylist toggles. |

### 4.3 What is extracted from transcripts (v0)

From `user/message` / `assistant/message` only:

- Concatenate `content[]` blocks with `type: text` (skip `reasoning` unless flag).
- Strip harness metadata prefix to a short tag.
- Skip `agent/inbox/spliced`, compaction internals, permission events.
- Do not return tool result payloads or attachments bytes (mention `[N attachment(s)]` only).

Chatroom peers (when enabled): reuse `searchableMessages` / `bodyOf` rules from `history-search.mjs`.

---

## 5. Storage

### 5.1 v0 — reuse transcripts (recommended start)

```
bindings.json  ──► resolve circle (OwnerLink + preset + filters)
       │
       ▼
findSessionLogPath(sessionId) → readSessionLog → filter/scan → capped text
```

- **Pros:** No dual-write; immediately covers QQ/Telegram/desktop; code already in `zstd-log.mjs`.
- **Cons:** Cold zstd decompress + scan can be slow on huge logs; must bound scan window.

**Mitigations:** only scan last N frames / last 4000 events; cache header + mtime → peer list for a few seconds; refuse sessions larger than soft byte threshold unless `sessionId` is explicit.

### 5.2 v1 — derived memory index under `channels-memory`

```
~\.dsh\channels-memory\
  circles\<circleId>\meta.json          # OwnerLink snapshot, member sessionIds
  circles\<circleId>\index.sqlite       # or jsonl segments: sessionId, seq, ts, role, text, channel
  circles\<circleId>\pins.jsonl
  journal.jsonl                         # rebuild / audit
```

- Populate by **tailing** new `user/message` / `assistant/message` (channel harness hook or session append listener) + periodic backfill.
- Chatroom: optional projector from `messages.jsonl`.
- Search hits resolve to index rows first; “get more context” may reopen transcript for neighbours.
- Rebuild must be idempotent; corruption → fall back to v0 scan and mark circle degraded.

### 5.3 Notes vs cross-session vs chatroom search

| Surface | Scope | Mutability | Use when |
| --- | --- | --- | --- |
| `search_history` | **This** chatroom only | read | Exact quote inside the room |
| `cross_session_*` | Peer sessions in Memory Circle | read (pins later write) | “What did we say on QQ yesterday?” |
| `note_*` | Distilled library | read/write | Stable facts, preferences, procedures |

Agents should prefer **notes** for long-lived preferences; use **cross_session_search** for episodic recall; use **search_history** inside a room.

---

## 6. How QQ ↔ Telegram ↔ desktop link

```
                 OwnerLink "shiro"
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
   QQ owner OpenID  TG owner id    Desktop profile
         │              │              │
         ▼              ▼              ▼
 bindings (dm,      bindings (dm,   durable desktop
 preset∈family)     preset∈family)  sessions with
         │              │           agentPreset∈family
         └──────────────┴──────────────┘
                        ▼
              Memory Circle members
              (sessionId set)
```

**Resolution algorithm (peer list):**

1. Load `bindings.json`; optionally desktop session index (proj cache / sessions root scan filtered by preset).
2. Drop denylist; drop `durability !== durable` if present.
3. Keep entries whose `senderId`/`conversationId` (for DMs) matches OwnerLink ids for that channel **or** binding key in allowlist.
4. Keep `route.preset ∈ presets` (or session header `agentPreset`).
5. If `shareGroups` false, drop `conversationType === group`.
6. Caller must itself pass steps 3–5 (or be desktop owner session / opted-in chatroom seat); else tools return “cross-session memory disabled here”.

**Desktop:** no binding row. Treat as member if: session workspace is the main desktop profile (not `channels/qq|telegram/...`), `agentPreset` in family, and session is durable / non-guest. Chatroom `guest` sidebar sessions are **never** peers (they are UI shells).

**Same human, different bots:** `telegram:main` vs `telegram:chatgpt` — chatgpt stays out unless its preset is added to `presets` (not recommended for Shiro defaults).

---

## 7. Phased delivery

### v0 — read-only tools on live transcripts (ship first)

1. Config: `crossSessionMemory` + one OwnerLink for Shiro.
2. Module e.g. `src/channels/cross-session-memory.mjs` (list + search + circle resolve).
3. Register tools on channel harness sessions + desktop; add to `OPEN_TOOLS` **and** gate on circle membership + owner-turn where appropriate.
4. Reuse `zstd-log.mjs`; strip metadata prefixes; enforce caps in §4.1.
5. Tests: fixtures from anonymized qq/telegram logs; deny chatgpt preset; deny group when `shareGroups: true   # user decision 2026-10-25: channel groups queryable`; token truncation.
6. **No** UI beyond maybe a settings checkbox “启用跨会话记忆”.

### v1 — derived store + pins

1. Writer into `~\.dsh\channels-memory\`.
2. Search prefers index; pins tools; rebuild command.
3. Optional: allowlisted Telegram groups.
4. Redaction helpers for PII patterns (phone, tokens) on index write.

### v2 — UI + chatroom bridge

1. Settings card: OwnerLink editor, circle members, denylist, shareGroups, chatroomShare.
2. Chatroom seat opt-in: seat may call `cross_session_*` for OwnerLink DMs; optional `room_share` the other way.
3. Audit log of tool invocations (session, peer, hit counts) under `channels-memory/journal.jsonl`.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| **Prompt injection** from foreign transcripts (“ignore instructions…”) | Wrap hits in clear quotation framing; strip system-role text; never promote foreign text to system; default omit reasoning/tools; remind model these are **untrusted retrieved quotes**. |
| **PII / secrets** in peer logs (tokens in metadata prefix, credentials pasted in chat) | Strip harness `message=` tokens; redact common secret patterns; don’t index tool results; notes policy already forbids secrets — same for pins. |
| **Cross-persona bleed** (chatgpt ↔ lingsnow) | Preset family filter mandatory in defaults. |
| **Group leakage** (other members’ messages into DM context) | `shareGroups: true   # user decision 2026-10-25: channel groups queryable` default; when enabled, prefer owner-only lines or anonymize senders. |
| **Token / cost blowups** | Caps in §4.1; max calls/turn; truncate. |
| **Confused deputy** (non-owner in TG group triggers tool, reads owner QQ DM) | Circle read requires **owner-authorized turn** (reuse owner-gate authorized set) for any peer outside the current conversation; non-owners get tool denied or empty. |
| **Ambiguous bindings** | Harness already fails closed on multi-bind (`AmbiguousBindingError`); peer list should skip ambiguous sessionIds. |
| **Performance** | Bound scan; v1 index; don’t decompress entire multi‑GB history. |
| **Legal / expectation** | Document that “limited recall” is still storing/retrieving personal chat; keep local-only (no cloud sync in this design). |

---

## 9. Recommended defaults for Shiro’s multi-channel DeepSeek setup

1. **`enabled: true`** with a single OwnerLink `shiro`: TG `6153059771` ↔ QQ `B4C6E62A8A0919E62678494F20F30530`.
2. **`presets: ["lingsnow"]` only** — do not include `chatgpt`, `guest`, `liangshen` unless asked.
3. **`includeChannels: ["qq","telegram","desktop"]`**, **`shareGroups: true   # user decision 2026-10-25: channel groups queryable`**, **`chatroomShare: false`**.
4. **v0 tools only**: `cross_session_list` + `cross_session_search`; caps as in §4.1 (6000 token results, 3 calls/turn).
5. **Owner-turn required** to read peers (desktop UI counts as owner).
6. Keep using **`note_*`** for stable prefs (“叫我 Shiro”、“别念 ROBOT 令牌”); use cross-session for “上次在 QQ 说的行程”.
7. Leave `~\.dsh\channels-memory\` empty until v1; do not invent a second bindings file.
8. Add both new tools to channel `OPEN_TOOLS` for naming consistency, but **enforce OwnerLink + owner-turn inside the tool** (OPEN_TOOLS alone is insufficient).

---

## 10. Open questions (for product confirmation)

See report to user — max three tracked here:

1. Should **desktop lingsnow** sessions auto-join the circle, or only channel DMs until explicitly listed?
2. ~~When `shareGroups` is later enabled…~~ **Decided 2026-10-25:** `shareGroups: true`; v0 returns full scanned dialogue with harness strip; owner-only / anonymize deferred to v1+.
3. May **chatroom lingsnow seats** read the QQ/Telegram DM circle in v0.5, or strictly v2?

---

## 11. Implementation sketch (not in this change)

Possible files later (do **not** create yet unless a stub is requested):

- `src/channels/cross-session-memory.mjs` — circle resolve, list, search  
- `src/channels/cross-session-memory.test.mjs`  
- Wire from `src/channels/telegram/index.mjs` / `qq/index.mjs` / desktop tool registration  
- Settings keys + `lib/client.js` labels (v0: single enable + owner link fields)  
- v1: `src/channels/memory-index.mjs` writing under `~\.dsh\channels-memory\`

**Out of scope for the design drop:** no stub required; this document is the deliverable.

---

## 12. Appendix — example circle for Shiro (v0)

| Member | Binding / session | In circle? |
| --- | --- | --- |
| QQ DM lingsnow | `qq:main:B4C6E62A…` → `ch-0d68ce84-…` | yes |
| TG DM lingsnow | `telegram:main:6153059771` → `ch-113465b2-…` | yes |
| TG group | `telegram:main:-1003435238151` | **no** (`shareGroups: true   # user decision 2026-10-25: channel groups queryable`) |
| TG thread | `…:40` → `ch-ee81a221-…` | **no** |
| TG chatgpt DM | `telegram:chatgpt:6153059771` | **no** (preset) |
| Desktop lingsnow chats | profile desktop sessions | **yes if Q1 default = auto** |
| Chatroom room messages | `rooms/room-…/messages.jsonl` | **no** until chatroomShare |

When the agent is in QQ DM and calls `cross_session_search({ query: "行程", limit: 5 })`, v0 searches Telegram DM **and** Telegram groups/threads in the same preset circle (labeled person vs group + peer id), returns ≤5 capped hits, and never opens the chatgpt (other-preset) sessions. Filter with `conversationType: "dm"` or `peerId` to narrow.

---

## 13. Person profile + alias map (slice 2026-10-25)

User decision (`pt1011u`): 称呼从聊天记录里取，也允许在通道设置里手动映射「出现的用户/群 ID → 显示名」；OwnerLink + 短 person summary 在通道回合注入 prompt。

### 13.1 Display-name priority

On inbound labels, `cross_session_list`, and `cross_session_search` hit lines:

1. **Manual alias** (settings `crossSessionAliases`)
2. **Learned / extracted** — Telegram `sender.name` (`first_name`) persisted to `~/.dsh/dsh-channels/peer-aliases-learned.json` on inbound; also parse `[person-memory] name=…` / `name=` in transcript prefixes
3. **Raw id**

QQ official API often has no nickname — aliases + history extraction are the path.

### 13.2 Alias map shape

Persisted as settings string (table UI serializes to the same line form). Parsed rows:

```json
{ "channel": "telegram"|"qq", "peerId": "<id>", "conversationType": "dm"|"group"|"" , "name": "<display>" }
```

Line forms accepted in UI:

```
telegram 6153059771 Shiro
qq B4C6E62A8A0919E62678494F20F30530 雪
telegram -1003435238151 家庭群 group
telegram:6153059771=Shiro
```

### 13.3 OwnerLink config

Hardcoded defaults (Shiro): TG `6153059771` ↔ QQ `B4C6E62A8A0919E62678494F20F30530`, preset `lingsnow`, `shareGroups: true`.

Editable settings (flat, Chinese UI on「跨会话记忆」card):

| Key | Meaning |
| --- | --- |
| `crossSessionMemoryEnabled` | Mount tools + inbound summary |
| `crossSessionOwnerTelegramIds` | OwnerLink TG ids (blank → default) |
| `crossSessionOwnerQqOpenIds` | OwnerLink QQ OpenIDs (blank → default) |
| `crossSessionPresets` | Persona family (blank → `lingsnow`) |
| `crossSessionShareGroups` | Include group sessions (default on) |
| `crossSessionAliases` | Alias map (table UI → line string) |

### 13.4 Person summary inject

On each channel inbound (QQ/Telegram harness `handleQueuedMessage`), prepend one text block:

```
[person-memory] channel=telegram kind=person peer=6153059771 name=Shiro role=owner circle=shiro | 对方称呼「Shiro」。跨通道细节请用 cross_session_list / cross_session_search，勿臆造。
```

Cap: **420 characters**. Full history still **pull-only** via tools — this is identity hint only, not a transcript dump.

Install: `person-memory-inject.mjs` → `installPersonMemoryInject(ChannelHarnessBridge)` from Telegram + QQ runtimes; provider set by `cross-session-feature`.

### 13.5 UI — how to set an alias

1. Open DSH 设置 → **通道** group → **跨会话记忆**
2. Ensure **启用** is on
3. In **称呼别名**, choose **通道类型** (Telegram / QQ) above the table, then add rows: 用户/群 ID · 称呼 · 类型（人/群/自动）
4. Save the card

Under the hood the table still saves as the compatible line form (`telegram 6153059771 Shiro`, optional trailing `dm`/`group`). Aliases apply immediately to list/search labels and the next inbound `[person-memory]` block.

