/**
 * In-memory session pins for Google discovery mode.
 * find_tools adds names here; selectExposedTools keeps them under the 512 cap.
 */

export function createPinStore({ maxPerSession = 64 } = {}) {
  /** @type {Map<string, string[]>} */
  const bySession = new Map()

  function keyOf(sessionId) {
    return sessionId == null || sessionId === '' ? '_default' : String(sessionId)
  }

  return {
    list(sessionId) {
      return (bySession.get(keyOf(sessionId)) || []).slice()
    },
    /**
     * @param {boolean} [fill] When true, keep existing pins and append until `max`.
     *   Do not drop older pins to make room (those were already reported as callable).
     *   Names that do not fit are `omitted`. `accepted` is the requested names still held.
     */
    add(sessionId, names, { max = maxPerSession, fill = false } = {}) {
      const key = keyOf(sessionId)
      const cur = bySession.get(key) || []
      const seen = new Set(cur)
      const added = []
      const omitted = []
      const limit = Math.max(0, Number(max) || 0)
      for (const raw of names || []) {
        const n = typeof raw === 'string' ? raw.trim() : ''
        if (!n || seen.has(n)) continue
        if (fill && cur.length >= limit) { omitted.push(n); continue }
        seen.add(n)
        cur.push(n)
        added.push(n)
      }
      const evicted = []
      if (!fill) {
        while (cur.length > limit) evicted.push(cur.shift())
      }
      bySession.set(key, cur)
      const kept = new Set(cur)
      const accepted = []
      const seenReq = new Set()
      for (const raw of names || []) {
        const n = typeof raw === 'string' ? raw.trim() : ''
        if (!n || seenReq.has(n)) continue
        seenReq.add(n)
        if (kept.has(n)) accepted.push(n)
        else if (!omitted.includes(n)) omitted.push(n)
      }
      return { added: added.filter((n) => kept.has(n)), pins: cur.slice(), accepted, omitted, evicted }
    },
    clear(sessionId) {
      bySession.delete(keyOf(sessionId))
    },
    clearAll() {
      bySession.clear()
    },
  }
}
