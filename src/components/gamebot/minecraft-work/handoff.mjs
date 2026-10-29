import { claimTask, revokeTask } from './claims.mjs'
import { refreshTasks } from './tasks.mjs'
import { rebuildProgressFromWorld, handoverRecord } from './reconcile.mjs'
import { releaseWorkspace } from './workspace.mjs'
import { releaseMemberReservations } from './materials.mjs'
import { canFinishReconciliation } from './reconciliation.mjs'

function occupying(project, taskId) {
  return project.inflight.filter((item) => item.task_id === taskId && (item.status === 'inflight' || item.status === 'unknown'))
}

export function finishReconciliation(project, { task_id, now, key, snapshot, evidence = {} }) {
  const task = project.tasks.find((item) => item.id === task_id)
  if (!task) return { ok: false, error: '没有这个任务' }
  rebuildProgressFromWorld(project, snapshot)
  const gate = canFinishReconciliation(project, task_id, {
    ...evidence,
    snapshot,
    now,
    agentPositions: evidence.agentPositions || {},
    pendingOperationIds: evidence.pendingOperationIds || [],
  })
  if (!gate.ok) {
    return { ok: false, error: '交接证据不足', issues: gate.issues, project }
  }
  const handover = handoverRecord(project, snapshot, { reason: project.reconcile?.reason })
  for (const claim of project.claims) {
    if (claim.tid === task_id && claim.status === 'reconciling') claim.status = 'revoked'
  }
  const gen = Math.max(project.revocations?.[task_id] || 0, ...project.claims.filter((c) => c.tid === task_id).map((c) => c.gen || 0))
  project.revocations = { ...project.revocations, [task_id]: gen }
  project.workspace = (project.workspace || []).map((r) => (
    r.task_id === task_id && r.status === 'held' ? { ...r, status: 'released' } : r
  ))
  if (task.status === 'reconciling') task.status = 'claimable'
  project.reconcile = null
  project.loop.phase = 'idle'
  project.tasks = refreshTasks(project.tasks)
  project.journal.push({ kind: 'reconcile_finish', task_id, at: now, handover })
  return { ok: true, project, handover, gen }
}

/** 作废旧凭证、确认在途已有结果、写入进度，然后才签发新认领。 */
export function handoff(project, { task_id, to, now, key, ttl_seconds, snapshot, evidence = {} }) {
  if (occupying(project, task_id).length) return { ok: false, error: '在途结果未知', project }
  if (snapshot) rebuildProgressFromWorld(project, snapshot)
  const previous = project.claims.find((c) => c.tid === task_id && c.status === 'active')
  const revoke = revokeTask(project, task_id, key)
  if (previous) {
    releaseMemberReservations(project, previous.mid, { uncollectedOnly: true })
  }
  project.journal.push({
    kind: 'progress',
    task_id,
    at: now,
    done: [...project.progress.done],
    from: previous?.mid ?? null,
  })
  const task = project.tasks.find((item) => item.id === task_id)
  if (task && task.status !== 'checkpoint' && task.status !== 'done' && task.status !== 'frozen') task.status = 'claimable'
  if (task?.status === 'checkpoint') {
    return { ok: true, project, revoke, claim: null, held: 'checkpoint' }
  }
  const next = claimTask(project, { member_id: to, task_id, now, key, ttl_seconds })
  if (!next.ok) return { ...next, revoke }
  return { ok: true, project: next.project, revoke, claim: next.claim }
}

/** 改版只作废包含改动格子的任务及其依赖。已完成且不受影响的凭证保留。 */
export function revise(project, { cell_keys, now }) {
  project.blueprint_version += 1
  const hit = new Set()
  for (const task of project.tasks) {
    if (task.cells.some((key) => cell_keys.includes(key))) hit.add(task.id)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const task of project.tasks) {
      if (hit.has(task.id)) continue
      if (task.depends_on.some((id) => hit.has(id))) {
        hit.add(task.id)
        grew = true
      }
    }
  }
  const revoked = []
  for (const taskId of hit) {
    const task = project.tasks.find((item) => item.id === taskId)
    for (const claim of project.claims) {
      if (claim.tid === taskId && claim.status === 'active') {
        claim.status = 'revoked'
        project.revocations[taskId] = Math.max(project.revocations[taskId] || 0, claim.gen)
        revoked.push(claim.tid)
      }
    }
    if (task && task.status !== 'done') task.status = 'claimable'
    if (task) task.blueprint_version = project.blueprint_version
  }
  project.tasks = refreshTasks(project.tasks)
  project.journal.push({ kind: 'revise', at: now, cells: cell_keys, tasks: [...hit] })
  return { ok: true, project, revoked: [...new Set(revoked)], kept: project.claims.filter((claim) => claim.status === 'active').map((claim) => claim.tid) }
}
