/**
 * Production bridge: GameBot member observe/act → scheduler world adapter.
 * Requires a live Minaret connection with place_block and block state in snapshots.
 */
import { memberRequest } from '../members.mjs'

const PLACE_CAP = 'minecraft.world.place_block'
const PROBE_CAP = 'minecraft.world.probe_blocks'

function playerPos(obs) {
  const p = obs?.position
  if (!p) return null
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

function blocksFromObservation(obs) {
  const mc = obs?.extras?.minecraft
  const list = mc?.nearby_blocks || mc?.nearbyBlocks || []
  const out = []
  for (const item of list) {
    const pos = item?.pos || item?.position
    if (!pos || item.block_id == null) continue
    out.push({
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      block_id: String(item.block_id),
      state: item.state && typeof item.state === 'object' ? { ...item.state } : {},
    })
  }
  return out
}

export function observationToSchedulerSnapshot(obs, { memberId = null, radius = 16 } = {}) {
  const agent = playerPos(obs)
  const mc = obs?.extras?.minecraft || {}
  const blocks = blocksFromObservation(obs)
  const truncated = mc.nearby_blocks_truncated !== false
  const dimension = mc.player?.dimension || mc.dimension || null
  if (!agent) {
    return {
      complete: false,
      omits_air: true,
      nearby_truncated: true,
      origin: null,
      agent: null,
      member_id: memberId,
      radius,
      dimension,
      blocks,
    }
  }
  // nearby_blocks never lists air and may drop everything past 512. A position is not a cell reading.
  return {
    complete: false,
    omits_air: true,
    nearby_truncated: truncated,
    origin: { ...agent },
    agent: { ...agent },
    member_id: memberId,
    radius,
    dimension,
    blocks,
  }
}

export function memberHasCapability(obs, capId) {
  const caps = obs?.capabilities || []
  for (const cap of caps) {
    if (cap.id === capId && cap.available) return true
  }
  return false
}

export function memberHasPlaceBlock(obs) {
  return memberHasCapability(obs, PLACE_CAP)
}

export function memberHasProbeBlocks(obs) {
  return memberHasCapability(obs, PROBE_CAP)
}

/**
 * @param {{ getConfig: () => object, memberId: string, fetchImpl?: typeof fetch }} opts
 */
export function createMemberBridgeWorld({ getConfig, memberId, fetchImpl } = {}) {
  if (!getConfig || !memberId) throw new Error('getConfig 与 memberId 必填')

  async function observeMember() {
    const cfg = getConfig()
    const obs = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/observe`, { fetchImpl })
    return observationToSchedulerSnapshot(obs, { memberId })
  }

  const world = {
    member_id: memberId,
    get agent() {
      return world._last?.agent || { x: 0, y: 64, z: 0 }
    },
    _last: null,
    _probeSeq: 0,
    currentProbeSeq() {
      return world._probeSeq
    },
    observe() {
      return world._last || { complete: false, blocks: [], member_id: memberId }
    },
    async reloadObservation() {
      world._last = await observeMember()
      return world.observe()
    },
    async probeBlocks({ positions }) {
      const cfg = getConfig()
      const result = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/actions`, {
        method: 'POST',
        body: { action: 'probe_blocks', params: { positions } },
        fetchImpl,
        timeoutMs: 15000,
      })
      const evidence = result?.extras?.evidence || {}
      if (!result?.ok) {
        return { ok: false, error: result?.error || result?.extras?.error_code || 'probe_failed', evidence }
      }
      if (Number.isFinite(evidence.probe_seq)) world._probeSeq = evidence.probe_seq
      return {
        ok: true,
        dimension: evidence.dimension,
        game_time: evidence.game_time,
        probe_seq: evidence.probe_seq,
        cells: evidence.cells || [],
      }
    },
    async act(action) {
      const cfg = getConfig()
      if (action.action === 'place_block') {
        const params = {
          pos: action.params.pos,
          block_id: action.params.block_id,
          state: action.params.state || {},
          face: action.params.face,
          max_distance: action.params.max_distance,
          claim: action.params.claim,
        }
        const result = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/actions`, {
          method: 'POST',
          body: { action: 'place_block', params },
          fetchImpl,
          timeoutMs: 45000,
        })
        const evidence = result?.extras?.evidence || {}
        const effect = result?.extras?.effect || (result.ok ? 'confirmed' : 'failed')
        if (effect === 'pending' || effect === 'unknown') {
          return { ok: true, effect, operation_id: action.operation_id, game_time: evidence.game_time, dimension: evidence.dimension, evidence, outcome: result }
        }
        if (!result.ok) {
          return { ok: false, effect: 'rejected', reason: result.error || result.extras?.error_code || 'action_failed', operation_id: action.operation_id, game_time: evidence.game_time, dimension: evidence.dimension, evidence }
        }
        return {
          ok: true,
          effect: effect === 'observed' ? 'confirmed' : effect,
          operation_id: action.operation_id,
          game_time: evidence.game_time,
          dimension: evidence.dimension,
          evidence,
        }
      }
      if (action.action === 'move_to') {
        const result = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/actions`, {
          method: 'POST',
          body: { action: 'move_to', params: action.params },
          fetchImpl,
          timeoutMs: 45000,
        })
        return { ok: result.ok, effect: result.ok ? 'confirmed' : 'rejected', outcome: result }
      }
      return { ok: false, effect: 'unsupported', reason: `unsupported action ${action.action}` }
    },
  }

  return world
}
