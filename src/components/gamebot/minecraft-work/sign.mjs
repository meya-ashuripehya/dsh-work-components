import { createHash, createHmac } from 'node:crypto'
import { CLAIM_BYTES } from './model.mjs'

/** 与模组 ClaimGate 使用同一条规范串。身份部分不含名称。 */
export function cellHash(cells) {
  const lines = (cells || []).map((c) => `${c.x},${c.y},${c.z}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function canonical(claim) {
  const acts = [...(claim.act || [])].map(String).sort().join(',')
  return ['v1', claim.mid, claim.tid, claim.pid, claim.bv, claim.gen, claim.exp, acts, cellHash(claim.cells)].join('|')
}

export function revokeCanonical(pid, tid, gen) {
  return `revoke|${pid}|${tid}|${gen}`
}

export function signText(text, key) {
  return createHmac('sha256', key).update(text).digest('hex')
}

export function signClaim(claim, key) {
  const body = {
    v: 1,
    mid: claim.mid,
    tid: claim.tid,
    pid: claim.pid,
    bv: claim.bv,
    gen: claim.gen,
    exp: claim.exp,
    act: [...claim.act],
    cells: claim.cells.map((c) => ({ x: c.x, y: c.y, z: c.z })),
  }
  const signed = { ...body, sig: signText(canonical(body), key) }
  const bytes = Buffer.byteLength(JSON.stringify(signed))
  if (bytes > CLAIM_BYTES) {
    const error = new Error('凭证超过 1024 字节')
    error.code = 'claim_too_large'
    throw error
  }
  return signed
}

export function signRevoke(pid, tid, gen, key) {
  return signText(revokeCanonical(pid, tid, gen), key)
}
