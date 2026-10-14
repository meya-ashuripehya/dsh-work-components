/** 可复现的洗牌。存档只记种子，不记牌面。 */
export function stepRng(prev) {
  let a = prev >>> 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { state: a >>> 0, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export function shuffle(items, seed) {
  const deck = items.slice()
  let state = seed >>> 0
  for (let i = deck.length - 1; i > 0; i--) {
    const drawn = stepRng(state)
    state = drawn.state
    const j = Math.floor(drawn.value * (i + 1))
    const swap = deck[i]
    deck[i] = deck[j]
    deck[j] = swap
  }
  return { deck, state }
}

export function stepInt(prev, n) {
  const drawn = stepRng(prev)
  return { state: drawn.state, value: Math.floor(drawn.value * n) }
}
