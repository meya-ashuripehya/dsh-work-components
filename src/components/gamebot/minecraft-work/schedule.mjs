import { claimTask } from './claims.mjs'
import { reserve, collectReserved } from './materials.mjs'
import { envelopeFor, reserveWorkspace } from './workspace.mjs'
import { posKey } from './model.mjs'
import { beginReconciliation, touchHeartbeat } from './ownership.mjs'
import { rebuildProgressFromWorld, canCompleteTask, cellSatisfied, materialDemandForTask } from './reconcile.mjs'
import { finishReconciliation } from './handoff.mjs'
import { canFinishReconciliation } from './reconciliation.mjs'
import { assignMembers } from './assign.mjs'

function cellsNeeded(project, task) {
  return task.cells
    .map((key) => project.cells.find((c) => posKey(c) === key))
    .filter((c) => c && c.kind === 'specified')
}

/** Shared entry: tools, demo, and runtime must use this (not raw claimTask + reserve). */
export function claimWork(project, ctx) {
  return scheduledClaim(project, ctx)
}

/** Atomically reserve materials + workspace, then claim. Rolls back on any failure. */
export function scheduledClaim(project, { member_id, task_id, now, ttl_seconds, key, agent_pos, snapshot, roster = null }) {
  if (project.legacy_blocked) return { ok: false, error: '项目缺少 world_id，已阻止调度' }
  const gate = claimTask(project, { member_id, task_id, now, ttl_seconds, key, dryRun: true })
  if (!gate.ok) return gate

  const task = gate.task
  const mats = materialDemandForTask(project, task, snapshot)

  const scratch = structuredClone(project)
  for (const [itemId, qty] of Object.entries(mats)) {
    const r = reserve(scratch, { member_id, item_id: itemId, qty, now, collect: true })
    if (!r.ok) return r
  }

  const needed = cellsNeeded(project, task)
  const remaining = snapshot ? needed.filter((cell) => !cellSatisfied(cell, snapshot)) : needed
  const env = envelopeFor(remaining[0] || needed[0] || task.pos, agent_pos)
  const ws = reserveWorkspace(scratch, { member_id, task_id, envelope: env, now })
  if (!ws.ok) return ws

  const claimed = claimTask(scratch, { member_id, task_id, now, ttl_seconds, key })
  if (!claimed.ok) return claimed
  touchHeartbeat(claimed.claim, now)
  claimed.claim.claimed_at = now
  claimed.claim.verified_progress_at = now
  if (roster) assignMembers(claimed.project, roster)
  claimed.project.control.execution = 'running'
  claimed.project.loop.phase = 'running'
  return claimed
}

export function heartbeat(project, { member_id, task_id, now }) {
  const claim = project.claims.find((c) => c.tid === task_id && c.mid === member_id && c.status === 'active')
  if (!claim) return { ok: false, error: '没有有效认领' }
  touchHeartbeat(claim, now)
  return { ok: true, project }
}

export function reconcileAndMaybeReclaim(project, { task_id, to, now, key, ttl_seconds, snapshot, agent_pos, evidence = {} }) {
  const task = project.tasks.find((t) => t.id === task_id)
  if (!task) return { ok: false, error: '没有这个任务' }
  const inflight = project.inflight.filter((e) => e.task_id === task_id && (e.status === 'inflight' || e.status === 'unknown'))
  if (inflight.length) return { ok: false, error: '在途结果未知', inflight: inflight.map((e) => e.operation_id) }

  rebuildProgressFromWorld(project, snapshot)
  const gate = canFinishReconciliation(project, task_id, {
    snapshot,
    now,
    agentPositions: evidence?.agentPositions || {},
    pendingOperationIds: evidence?.pendingOperationIds || [],
  })
  if (!gate.ok) return { ok: false, error: '交接证据不足', issues: gate.issues, project }
  const fin = finishReconciliation(project, { task_id, now, key, snapshot, evidence })
  if (!fin.ok) return fin
  if (canCompleteTask(project, task, snapshot)) {
    task.status = 'done'
    return { ok: true, project, completed: true, handover: fin.handover }
  }
  if (!to) return { ok: true, project, completed: false, handover: fin.handover }
  return scheduledClaim(project, { member_id: to, task_id, now, ttl_seconds, key, agent_pos, snapshot })
}
