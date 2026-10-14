import { isJsonValue } from '../../vendor/dsh-tools/util-values.js'
import { CardError } from './errors.mjs'

/**
 * Coerce a tool result into lossless JSON (DSH rejects anything that does not round-trip).
 * Drops undefined/function/symbol object fields, maps them to null in arrays, NaN/Infinity -> null,
 * -0 -> 0, Date -> ISO string, Map/Set -> array/object, BigInt -> number|string, cycles -> rejected.
 */
export function toLosslessJson(value) {
  const seen = new Set()
  const walk = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v)
    if (typeof v !== 'object') return undefined
    if (seen.has(v)) throw new CardError('牌局结果含循环引用')
    if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null
    seen.add(v)
    try {
      if (v instanceof Map) return walk(Object.fromEntries(v))
      if (v instanceof Set) return walk([...v])
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        return Array.from({ length: v.length }, (_, i) => { const item = walk(v[i]); return item === undefined ? null : item })
      }
      const out = {}
      for (const key of Object.keys(v)) {
        const item = walk(v[key])
        if (item !== undefined) out[key] = item
      }
      return out
    } finally { seen.delete(v) }
  }
  const out = walk(value)
  const result = out === undefined ? null : out
  if (!isJsonValue(result)) throw new CardError('牌局结果无法序列化为 JSON')
  return result
}
