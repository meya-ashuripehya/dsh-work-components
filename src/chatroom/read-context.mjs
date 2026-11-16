import { isPromptCandidate } from './ctx-compress.mjs'

/** Shared read-only visibility/window selection; no room scheduling or tools. */
export function contextWindow(messages, { untilSeq = 0, binned, limit = 24 } = {}) {
  const visible = (messages || []).filter((m) => isPromptCandidate(m, untilSeq) && !(m.kind === 'tool' && binned?.has(m.id)))
  return limit > 0 ? visible.slice(-limit) : visible
}

export async function readRoomMemory(store, roomId) {
  if (!roomId || !store?.getRoom || !store?.readMessages) return { summary: '', messages: [] }
  const [meta, messages] = await Promise.all([store.getRoom(roomId), store.readMessages(roomId)])
  return {
    summary: String(meta.contextSummary?.text || '').slice(0, 6000),
    messages: contextWindow((messages || []).filter((m) => m.audience !== 'private'), { untilSeq: meta.contextSummary?.untilSeq || 0, binned: new Set(Object.keys(meta.cardBin || {})) })
      .map((m) => ({ id: m.mcMessageId || m.id, source: m.source || m.via || 'room', speaker: m.speaker?.name || m.speaker?.id || m.kind, text: String(m.aiText || m.text || '').slice(0, 2000) })),
  }
}
