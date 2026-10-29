import { activeReservations } from './workspace.mjs'

export function agentOccupiesEnvelope(envelope, agentPos) {
  if (!agentPos || !envelope) return true
  const parts = [agentPos, { x: agentPos.x, y: agentPos.y + 1, z: agentPos.z }]
  for (const p of parts) {
    if (
      p.x >= envelope.min.x && p.x <= envelope.max.x
      && p.y >= envelope.min.y && p.y <= envelope.max.y
      && p.z >= envelope.min.z && p.z <= envelope.max.z
    ) return true
  }
  return false
}

/** Evidence must come from adapter observations, not caller assertions. */
export function reassignmentEvidence(project, taskId, { agentPositions = {}, pendingOperationIds = [], snapshot = null } = {}) {
  const issues = []
  if (!snapshot || snapshot.complete === false) issues.push({ kind: 'incomplete_observation' })
  const inflight = project.inflight.filter((e) => e.task_id === taskId && (e.status === 'inflight' || e.status === 'unknown'))
  for (const e of inflight) issues.push({ kind: 'unresolved_inflight', operation_id: e.operation_id })
  for (const op of pendingOperationIds || []) issues.push({ kind: 'sim_pending', operation_id: op })
  const held = activeReservations(project).filter((r) => r.task_id === taskId && r.status === 'held')
  for (const r of held) {
    const pos = agentPositions[r.member_id]
    if (pos == null) issues.push({ kind: 'unknown_agent_position', member_id: r.member_id })
    else if (agentOccupiesEnvelope(r.envelope, pos)) {
      issues.push({ kind: 'workspace_occupied', member_id: r.member_id })
    }
  }
  return { ok: issues.length === 0, issues }
}

export function canFinishReconciliation(project, taskId, evidence) {
  const gate = reassignmentEvidence(project, taskId, evidence)
  if (!gate.ok) {
    project.reconcile = {
      ...(project.reconcile || {}),
      task_id: taskId,
      needs_operator: false,
      blocked_reason: gate.issues[0]?.kind || 'blocked',
      evidence: gate.issues,
      at: evidence.now,
    }
    project.loop.phase = 'reconciling'
    return { ok: false, issues: gate.issues }
  }
  return { ok: true }
}
