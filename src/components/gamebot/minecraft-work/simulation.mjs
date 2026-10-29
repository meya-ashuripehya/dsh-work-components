import { posKey, parseKey } from './model.mjs'
import { normalizeState } from './blocks.mjs'

let nextOp = 1
export function resetSimOpIds() {
  nextOp = 1
}

function blockEntry(block_id, state = {}) {
  return { block_id, state: normalizeState(state) }
}

/**
 * Authoritative in-memory world for offline acceptance.
 * Mutations apply only when a delayed action completes with valid authority.
 */
export function createSimWorld({
  clock = () => 0,
  blocks = [],
  agents = {},
  reach = 4.5,
} = {}) {
  const blockMap = new Map()
  for (const b of blocks) {
    blockMap.set(posKey(b), blockEntry(b.block_id, b.state))
  }
  const positions = new Map(Object.entries(agents))
  const pending = []
  const completed = []
  const authority = { revocations: {}, cancelled: new Set() }
  const effected = new Set()
  const probeState = { seq: 0 }
  const dimension = 'minecraft:overworld'

  function agentPos(memberId) {
    return positions.get(memberId) || null
  }

  function setAgent(memberId, pos) {
    positions.set(memberId, { ...pos })
  }

  function observeFor(memberId, radius = 16) {
    const origin = agentPos(memberId) || { x: 0, y: 64, z: 0 }
    const out = []
    for (const [key, val] of blockMap) {
      const p = parseKey(key)
      if (Math.abs(p.x - origin.x) > radius || Math.abs(p.y - origin.y) > radius || Math.abs(p.z - origin.z) > radius) continue
      out.push({ ...p, block_id: val.block_id, state: { ...val.state } })
    }
    return {
      complete: true,
      origin: { ...origin },
      agent: { ...origin },
      member_id: memberId,
      radius,
      blocks: out,
    }
  }

  function distance(a, b) {
    const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  function jobAuthorized(job, now) {
    if (authority.cancelled.has(job.operation_id)) return false
    if (!job.tid || !job.gen) return false
    const floor = authority.revocations[job.tid] || 0
    if (job.gen <= floor) return false
    if (job.exp && job.exp <= now) return false
    return true
  }

  function timed(outcome, now) {
    return {
      ...outcome,
      game_time: now,
      dimension,
      evidence: { ...(outcome.evidence || {}), game_time: now, dimension },
    }
  }

  function probeBlocks({ positions }) {
    const now = clock()
    probeState.seq += 1
    const cells = (positions || []).map((pos) => {
      const got = blockMap.get(posKey(pos))
      return {
        pos: { x: pos.x, y: pos.y, z: pos.z },
        loaded: true,
        block_id: got?.block_id || 'minecraft:air',
        state: got ? { ...got.state } : {},
      }
    })
    return { ok: true, dimension, game_time: now, probe_seq: probeState.seq, cells }
  }

  function replayOutcome(job) {
    const prior = completed.find((c) => c.operation_id === job.operation_id && c.outcome?.ok)
    if (prior) return prior.outcome
    return { ok: true, effect: 'confirmed', operation_id: job.operation_id, idempotent: true }
  }

  function applyJob(job) {
    if (effected.has(job.operation_id)) {
      completed.push({ ...job, outcome: replayOutcome(job) })
      return
    }
    if (job.action.action === 'move_to') {
      setAgent(job.member_id, job.action.params)
      effected.add(job.operation_id)
      completed.push({ ...job, outcome: timed({ ok: true, effect: 'confirmed', operation_id: job.operation_id }, clock()) })
      return
    }
    if (job.action.action === 'place_block') {
      const pos = job.action.params.pos
      const key = posKey(pos)
      blockMap.set(key, blockEntry(job.action.params.block_id, job.action.params.state || {}))
      effected.add(job.operation_id)
      completed.push({ ...job, outcome: timed({ ok: true, effect: 'confirmed', operation_id: job.operation_id }, clock()) })
      return
    }
    completed.push({ ...job, outcome: { ok: false, effect: 'unsupported', operation_id: job.operation_id } })
  }

  function flushPending(now) {
    const rest = []
    for (const job of pending) {
      if (job.completeAt > now) {
        rest.push(job)
        continue
      }
      if (!jobAuthorized(job, now)) {
        completed.push({ ...job, outcome: { ok: false, effect: 'rejected', operation_id: job.operation_id, reason: 'authority_revoked' } })
        continue
      }
      applyJob(job)
    }
    pending.length = 0
    pending.push(...rest)
  }

  function attachClaim(job, action) {
    const claim = action.params?.claim
    if (!claim) return
    job.tid = claim.tid
    job.gen = claim.gen
    job.mid = claim.mid
    job.exp = claim.exp
  }

  function act(action, { member_id, delay = 0, dropAck = false } = {}) {
    const now = clock()
    flushPending(now)
    const operation_id = action.operation_id || `sim-op-${nextOp++}`
    const memberId = member_id || action.member_id
    if (action.action === 'place_block') {
      const pos = action.params.pos
      const ap = agentPos(memberId)
      if (!ap || distance(ap, pos) > reach) {
        return { ok: false, effect: 'rejected', operation_id, reason: 'out_of_reach' }
      }
      const support = blockMap.get(posKey({ x: pos.x, y: pos.y - 1, z: pos.z }))
      const supportId = support?.block_id || 'minecraft:air'
      if (action.params.block_id === 'minecraft:red_carpet' && supportId === 'minecraft:air') {
        return { ok: false, effect: 'rejected', operation_id, reason: 'no_support' }
      }
    }
    if (effected.has(operation_id)) {
      return replayOutcome({ operation_id, action })
    }
    const duplicatePending = pending.some((j) => j.operation_id === operation_id)
    if (duplicatePending) {
      return { ok: true, effect: 'pending', operation_id, duplicate: true }
    }
    const completeAt = now + (delay || 0)
    const job = { operation_id, member_id: memberId, action, completeAt, dropAck }
    attachClaim(job, action)
    if (!jobAuthorized(job, now)) {
      return { ok: false, effect: 'rejected', operation_id, reason: 'authority_revoked' }
    }
    if (delay > 0) {
      pending.push(job)
      if (dropAck) {
        return { ok: true, effect: 'unknown', operation_id, degrade_reason: 'needs_reconciliation' }
      }
      return { ok: true, effect: 'pending', operation_id, completes_at: completeAt }
    }
    pending.push(job)
    flushPending(now)
    const last = completed.find((c) => c.operation_id === operation_id)
    if (last) return last.outcome
    return { ok: true, effect: 'confirmed', operation_id }
  }

  function advanceTime(to) {
    flushPending(to)
  }

  function rejectOperation(operation_id) {
    authority.cancelled.add(operation_id)
  }

  function syncAuthority(project) {
    authority.revocations = { ...(project?.revocations || {}) }
  }

  function cancelPendingFor({ taskId, memberId } = {}) {
    for (const job of pending) {
      if (taskId && job.tid !== taskId) continue
      if (memberId && job.mid !== memberId) continue
      authority.cancelled.add(job.operation_id)
    }
  }

  function pendingOperationIds({ taskId, memberId } = {}) {
    return pending
      .filter((j) => (!taskId || j.tid === taskId) && (!memberId || j.mid === memberId))
      .map((j) => j.operation_id)
  }

  function setBlock(pos, block_id, state = {}) {
    blockMap.set(posKey(pos), blockEntry(block_id, state))
  }

  function worldView(memberId) {
    return {
      member_id: memberId,
      agent: agentPos(memberId) || { x: 0, y: 64, z: 0 },
      blocks: blockMap,
      observe() {
        return observeFor(memberId)
      },
      async act(action) {
        return act({ ...action, operation_id: action.operation_id }, { member_id: memberId, delay: action.delay, dropAck: action.dropAck })
      },
      advanceTime,
      rejectOperation,
      getBlock(pos) {
        return blockMap.get(posKey(pos)) || blockEntry('minecraft:air')
      },
      probeBlocks,
      currentProbeSeq() {
        return probeState.seq
      },
      setBlock(pos, block_id, state) {
        blockMap.set(posKey(pos), blockEntry(block_id, state))
      },
    }
  }

  function getBlock(pos) {
    return blockMap.get(posKey(pos)) || blockEntry('minecraft:air')
  }

  return {
    clock,
    setAgent,
    setBlock,
    getBlock,
    agentPos,
    observeFor,
    probeBlocks,
    currentProbeSeq: () => probeState.seq,
    act,
    advanceTime,
    rejectOperation,
    syncAuthority,
    cancelPendingFor,
    pendingOperationIds,
    worldView,
    pendingCount: () => pending.length,
    blockMap,
    agentPositions: () => Object.fromEntries(positions),
  }
}

export function bindSimToMember(sim, memberId) {
  const view = sim.worldView(memberId)
  return {
    ...view,
    observe() {
      return view.observe()
    },
    syncAuthority(project) {
      sim.syncAuthority(project)
    },
    cancelPendingFor(opts) {
      sim.cancelPendingFor(opts)
    },
    pendingOperationIds(opts) {
      return sim.pendingOperationIds(opts)
    },
    agentPositions() {
      return sim.agentPositions()
    },
  }
}
