const INBOUND = Symbol.for('dsh-workbench.cards.inbound')

export function setCardsInbound(fn) { globalThis[INBOUND] = fn }
export function clearCardsInbound(fn) { if (globalThis[INBOUND] === fn) delete globalThis[INBOUND] }
export function getCardsInbound() { return globalThis[INBOUND] || null }
