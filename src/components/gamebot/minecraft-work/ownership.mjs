import { usableClaim as baseUsable } from './claims.mjs'
import { bumpControlRevision } from './control.mjs'

export const NO_PROGRESS_SECONDS = 120
export const RECOVERY_ESCALATE_SECONDS = 300

export function touchHeartbeat(claim, now) {
  claim.heartbeat_at = now
  return claim
}

export function recordVerifiedProgress(claim, now) {
  claim.heartbeat_at = now
  claim.verified_progress_at = now
  return claim
}

export function beginReconciliation(project, taskId, { reason, now, evidence = [] }) {
  const task = project.tasks.find((t) => t.id === taskId)
  if (task && task.status !== 'done') task.status = 'reconciling'
  for (const claim of project.claims) {
    if (claim.tid === taskId && (claim.status === 'active' || claim.status === 'expired')) {
      if (claim.status === 'active') {
        const gen = Math.max(project.revocations?.[taskId] || 0, claim.gen)
        project.revocations = { ...project.revocations, [taskId]: gen }
      }
      claim.status = 'reconciling'
      claim.reconcile = { reason, at: now, evidence }
    }
  }
  bumpControlRevision(project)
  project.loop.phase = 'reconciling'
  project.reconcile = {
    task_id: taskId,
    reason,
    at: now,
    needs_operator: false,
    evidence,
    escalated_at: null,
  }
  project.journal.push({ kind: 'reconcile_begin', task_id: taskId, reason, at: now })
  return project
}

export function escalateReconciliation(project, now) {
  if (!project.reconcile) return project
  if (project.reconcile.escalated_at) return project
  const age = now - (project.reconcile.at || now)
  if (age < RECOVERY_ESCALATE_SECONDS) return project
  project.reconcile.needs_operator = true
  project.reconcile.escalated_at = now
  project.loop.phase = 'blocked'
  project.journal.push({ kind: 'reconcile_escalate', at: now, reconcile: { ...project.reconcile } })
  return project
}

/** Lease expiry and heartbeat-without-progress both enter reconciliation first. */
export function tickOwnership(project, now) {
  for (const claim of project.claims) {
    if (claim.status !== 'active') continue
    if (claim.exp <= now) {
      beginReconciliation(project, claim.tid, { reason: 'lease_expired', now })
      claim.status = 'reconciling'
      continue
    }
    const lastProgress = claim.verified_progress_at ?? claim.claimed_at ?? now
    const heartbeat = claim.heartbeat_at ?? claim.claimed_at ?? now
    if (heartbeat > lastProgress && now - lastProgress >= NO_PROGRESS_SECONDS) {
      beginReconciliation(project, claim.tid, { reason: 'no_progress', now })
      claim.status = 'reconciling'
    }
  }
  escalateReconciliation(project, now)
  return project
}

export function activeClaimForMember(project, taskId, memberId, now) {
  const candidates = project.claims.filter((c) => c.tid === taskId && c.status === 'active' && c.exp > now && c.mid === memberId)
  if (!candidates.length) return { ok: false, error: '没有该成员的有效认领' }
  candidates.sort((a, b) => b.gen - a.gen)
  return { ok: true, claim: candidates[0] }
}

export function highestGenerationClaim(project, taskId) {
  const relevant = project.claims.filter((c) => c.tid === taskId)
  if (!relevant.length) return 0
  return Math.max(...relevant.map((c) => c.gen || 0), project.revocations?.[taskId] || 0)
}

export function claimGenerationValid(project, claim) {
  const floor = (project.revocations?.[claim.tid] || 0) + 1
  if (claim.gen < floor) return false
  const newer = project.claims.some((c) => c.tid === claim.tid && c.gen > claim.gen && c.status !== 'revoked')
  return !newer
}

export function usableClaim(project, taskId, now, memberId = null) {
  const gate = baseUsable(project, taskId, now)
  if (!gate.ok) return gate
  if (memberId && gate.claim.mid !== memberId) return { ok: false, error: '认领不属于该成员' }
  if (!claimGenerationValid(project, gate.claim)) return { ok: false, error: '认领代际已作废' }
  return gate
}
