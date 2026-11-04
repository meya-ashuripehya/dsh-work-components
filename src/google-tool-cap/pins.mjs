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
    add(sessionId, names, { max = maxPerSession } = {}) {
      const key = keyOf(sessionId)
      const cur = bySession.get(key) || []
      const seen = new Set(cur)
      const added = []
      for (const raw of names || []) {
        const n = typeof raw === 'string' ? raw.trim() : ''
        if (!n || seen.has(n)) continue
        seen.add(n)
        cur.push(n)
        added.push(n)
      }
      while (cur.length > max) cur.shift()
      bySession.set(key, cur)
      return { added, pins: cur.slice() }
    },
    clear(sessionId) {
      bySession.delete(keyOf(sessionId))
    },
    clearAll() {
      bySession.clear()
    },
  }
}
