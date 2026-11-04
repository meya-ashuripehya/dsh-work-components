# Platform surface (tools decide; model does not see)

**Policy:** Outbound adapters and tool `execute` paths resolve `channelId` (`desktop` | `telegram` | `qq`) from harness event / session origin / bridge registries. Do **not** put platform names into model-visible tool descriptions, system prompts, or card text the model reads back.

## Canonical helpers

| Export | Use |
|--------|-----|
| `resolveChannelId(input)` | Prefer origin/event/binding, else session Telegram/QQ registry, else `desktop` |
| `resolveSurface(input)` | `{ channelId, capabilities, peerId?, … }` for transports |
| `originForSession(sessionId)` | Bind cards/boards; Telegram full origin, QQ stub origin |
| `lookupSessionChannelHit(sessionId)` | Raw hit from Telegram bridge or QQ session-origin map |
| `CHANNEL_CAPABILITIES` | QQ `calendarCard` true (PNG); map/board still `false` |

Module: `src/channels/surface.mjs`. QQ registry: `src/channels/qq/session-origin.mjs` (install via ReplyContextStore.register when QQ runtime notes inbound).

## How tools get channelId without the AI seeing it

1. Inbound Telegram/QQ notes `sessionId → origin` in a process Map (Telegram: boards-link / telegram-bridge; QQ: `noteQQSessionOrigin`).
2. Tool `execute({ … }, exec)` calls `resolveChannelId({ sessionId: exec.agent.id })` or `originForSession(exec.agent.id)` — **runtime only**, not passed through the tool schema / description.
3. Outbound picks the adapter from `capabilitiesFor(channelId)` (QQ map/board still stub; calendar uses tool-side PNG).
4. Model-facing strings stay platform-neutral (“Show a calendar card”, not “Send a Telegram calendar”).

## Status (skeleton slice)

- Shared module + QQ session-origin + capability matrix: done.
- Cards/boards paths resolve via `originForSession` (telegram + qq stub).
- QQ calendar PNG: done (calendar_show + harness image when channelId==='qq'). Telegram stays HTML (installCalendarDelivery). Map/board QQ: still stub.
