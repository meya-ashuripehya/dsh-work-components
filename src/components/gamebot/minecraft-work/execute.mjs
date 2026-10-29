import { posKey } from './model.mjs'
import { authorize } from './auth.mjs'
import { blockEquals, snapshotBlock } from './blocks.mjs'
import { actionGameTime, assessProbe } from './probe.mjs'
import { interrupt } from './slots.mjs'
import { consumeForOperation, releaseMemberReservations, refundOperation } from './materials.mjs'
import { beginReconciliation, claimGenerationValid, recordVerifiedProgress } from './ownership.mjs'
import { bumpControlRevision } from './control.mjs'

let opSeq = 1
export function resetExecuteOpIds() {
  opSeq = 1
}

export function nextOperationId(prefix = 'op') {
  return `${prefix}-${opSeq++}`
}

function seenOperation(project, operationId, currentEntry = null) {
  return project.inflight.some((e) => e.operation_id === operationId && e !== currentEntry)
}

export function assertCanMutate(project, claim, { operation_id, now, currentEntry = null }) {
  if (!claim || claim.status !== 'active') return { ok: false, error: '没有有效认领' }
  if (claim.exp <= now) return { ok: false, error: '认领已过期' }
  if (!claimGenerationValid(project, claim)) return { ok: false, error: '认领代际已作废' }
  if (operation_id && seenOperation(project, operation_id, currentEntry)) return { ok: false, error: '重复的操作 id', duplicate: true }
  return { ok: true }
}

async function freshSnapshot(world) {
  if (typeof world.reloadObservation === 'function') {
    return await world.reloadObservation()
  }
  return world.observe()
}

async function observedCell(project, world, cell, { beforeSeq, outcome }) {
  if (typeof world.probeBlocks === 'function') {
    const probe = await world.probeBlocks({
      positions: [{ x: cell.x, y: cell.y, z: cell.z }],
    })
    const verdict = assessProbe(probe, {
      beforeSeq,
      afterGameTime: actionGameTime(outcome),
      dimension: project.anchor?.dimension,
    })
    if (!verdict.ok) return { unknown: true, reason: verdict.reason, probe }
    const found = verdict.cells[0]
    return { block_id: found.block_id, state: found.state || {}, probe_seq: probe.probe_seq, game_time: probe.game_time }
  }
  const snapshot = await freshSnapshot(world)
  return snapshotBlock(snapshot, cell)
}

export async function dispatchPlace(project, world, claim, cell, ctx) {
  const { now, globalInflight = [] } = ctx
  const operation_id = ctx.operation_id || nextOperationId('place')
  const pre = assertCanMutate(project, claim, { operation_id, now })
  if (!pre.ok) return { ok: false, error: pre.error, duplicate: pre.duplicate }

  const gate = authorize(project, claim, cell, 'place')
  if (!gate.ok) return { ok: false, error: gate.error }

  const dispatch = interrupt(project, globalInflight, {
    member_id: claim.mid,
    sent: false,
    next: { operation_id, task_id: claim.tid, kind: 'build' },
  })
  if (!dispatch.dispatched && dispatch.reason) return { ok: false, error: dispatch.reason }

  const action = {
    action: 'place_block',
    operation_id,
    params: {
      pos: { x: cell.x, y: cell.y, z: cell.z },
      block_id: cell.block_id,
      state: cell.state,
      face: 'down',
      max_distance: 4.5,
      claim,
    },
    delay: ctx.delay,
    dropAck: ctx.dropAck,
  }

  world.syncAuthority?.(project)
  const beforeSeq = typeof world.currentProbeSeq === 'function' ? world.currentProbeSeq() : 0
  const outcome = await Promise.resolve(world.act(action))
  const entry = project.inflight.find((e) => e.operation_id === operation_id)
  const post = assertCanMutate(project, claim, { operation_id, now: ctx.nowAfter ?? now, currentEntry: entry })
  if (!post.ok) {
    world.cancelPendingFor?.({ taskId: claim.tid, memberId: claim.mid })
    world.rejectOperation?.(operation_id)
    return { ok: false, error: post.error, stale: true, operation_id }
  }
  if (entry) {
    entry.cell_key = posKey(cell)
    entry.sent = true
    if (outcome?.effect === 'unknown' || outcome?.degrade_reason === 'needs_reconciliation') {
      entry.status = 'unknown'
      project.unknown.push(entry)
      return { ok: false, unknown: true, operation_id, outcome }
    }
    if (outcome?.effect === 'pending') {
      entry.status = 'inflight'
      return { ok: true, pending: true, operation_id, outcome, cell }
    }
    if (!outcome || outcome.effect === 'rejected' || outcome.ok === false) {
      entry.status = 'rejected'
      return { ok: false, error: outcome?.reason || '动作被拒绝', operation_id }
    }
  }

  const observed = await observedCell(project, world, cell, { beforeSeq, outcome })
  if (observed.unknown) {
    return { ok: false, error: '观察未知', reason: observed.reason, operation_id, observed, used_fresh_observation: true }
  }
  if (!blockEquals(cell.block_id, cell.state, observed)) {
    return { ok: false, error: '世界状态未匹配', operation_id, observed, used_fresh_observation: true }
  }

  const mat = consumeForOperation(project, claim.mid, cell, { operation_id, now })
  if (!mat.ok) return { ok: false, error: mat.error, operation_id }

  if (entry) entry.status = 'settled'
  if (!project.progress.done.includes(posKey(cell))) project.progress.done.push(posKey(cell))
  recordVerifiedProgress(claim, now)
  return { ok: true, operation_id, verified: true, used_fresh_observation: true }
}

export async function settleInflight(project, world, claim, now) {
  const open = project.inflight.filter((e) => e.member_id === claim.mid && e.status === 'inflight')
  const results = []
  world.syncAuthority?.(project)
  for (const entry of open) {
    const post = assertCanMutate(project, claim, { operation_id: entry.operation_id, now, currentEntry: entry })
    if (!post.ok) {
      entry.status = 'rejected'
      results.push({ operation_id: entry.operation_id, ok: false, error: post.error })
      continue
    }
    const snapshot = await freshSnapshot(world)
    if (!snapshot?.complete) {
      results.push({ operation_id: entry.operation_id, ok: false, error: '观察不完整' })
      continue
    }
    const cellKey = entry.cell_key
    const cell = project.cells.find((c) => posKey(c) === cellKey)
    if (!cell) {
      entry.status = 'settled'
      continue
    }
    const observed = snapshotBlock(snapshot, cell)
    if (!blockEquals(cell.block_id, cell.state, observed)) {
      results.push({ operation_id: entry.operation_id, ok: false, error: '世界状态未匹配' })
      continue
    }
    const mat = consumeForOperation(project, claim.mid, cell, { operation_id: entry.operation_id, now })
    if (!mat.ok) {
      results.push({ operation_id: entry.operation_id, ok: false, error: mat.error })
      continue
    }
    entry.status = 'settled'
    if (!project.progress.done.includes(cellKey)) project.progress.done.push(cellKey)
    recordVerifiedProgress(claim, now)
    results.push({ operation_id: entry.operation_id, ok: true })
  }
  return results
}

export function mergeCommittedWorkState(target, work) {
  if (!work) return target
  const done = new Set([...(target.progress?.done || []), ...(work.progress?.done || [])])
  target.progress.done = [...done]
  for (const [itemId, item] of Object.entries(work.materials?.items || {})) {
    const dest = target.materials?.items?.[itemId]
    if (!dest) continue
    for (const c of item.consumed || []) {
      if ((dest.consumed || []).some((x) => x.operation_id === c.operation_id)) continue
      dest.consumed = dest.consumed || []
      dest.consumed.push(c)
      const carried = dest.carried[c.member_id] || 0
      if (carried >= c.qty) dest.carried[c.member_id] = carried - c.qty
    }
    for (const [mid, qty] of Object.entries(item.carried || {})) {
      if (qty != null) dest.carried[mid] = qty
    }
  }
  for (const entry of work.inflight || []) {
    const cur = target.inflight.find((e) => e.operation_id === entry.operation_id)
    if (!cur) continue
    if (entry.status === 'settled' || entry.status === 'unknown') cur.status = entry.status
  }
  return target
}

export function applyTickWorkState(target, work) {
  target.progress = work.progress
  target.inflight = work.inflight
  target.unknown = work.unknown
  target.replacements = work.replacements
  target.journal = work.journal
  target.materials = work.materials
  target.claims = work.claims
  target.loop = work.loop
  target.control = work.control
  target.conflicts = work.conflicts
  target.tasks = work.tasks
  target.scaffolds = work.scaffolds
  target.reconcile = work.reconcile
  target.workspace = work.workspace
  target.revocations = work.revocations
  if (work._blocks) target._blocks = work._blocks
  return target
}

export function voluntaryRelease(project, taskId, memberId, now, key, world = null) {
  const claim = project.claims.find((c) => c.tid === taskId && c.mid === memberId && c.status === 'active')
  if (!claim) return { ok: false, error: '没有可释放的认领' }
  claim.status = 'released'
  const gen = Math.max(project.revocations?.[taskId] || 0, claim.gen)
  project.revocations = { ...project.revocations, [taskId]: gen }
  world?.syncAuthority?.(project)
  world?.cancelPendingFor?.({ taskId, memberId })
  releaseMemberReservations(project, memberId, { uncollectedOnly: true })
  beginReconciliation(project, taskId, { reason: 'voluntary_release', now, evidence: [{ kind: 'released_by', member_id: memberId }] })
  bumpControlRevision(project)
  return { ok: true, project, gen }
}
