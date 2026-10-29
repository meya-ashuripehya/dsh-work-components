import { TTL_SECONDS, parseKey, posKey } from './model.mjs'
import { signClaim, signRevoke } from './sign.mjs'
import { executable, refreshTasks } from './tasks.mjs'
import { beginReconciliation } from './ownership.mjs'

function cellsFor(project, task) {
  const cells = []
  const act = new Set()
  for (const key of task.cells) {
    const cell = project.cells.find((item) => posKey(item) === key)
    if (!cell) continue
    if (cell.kind === 'specified') {
      cells.push({ x: cell.x, y: cell.y, z: cell.z })
      act.add('place')
    }
    if (cell.grants_break) {
      cells.push({ x: cell.x, y: cell.y, z: cell.z })
      act.add('break')
    }
  }
  for (const pad of project.scaffolds || []) {
    if (pad.status !== 'up') continue
    cells.push({ x: pad.x, y: pad.y, z: pad.z })
    act.add('place')
  }
  return { cells, act: [...act] }
}

export function activeClaim(project, taskId, now) {
  return project.claims.find((claim) => claim.tid === taskId && claim.status === 'active' && claim.exp > now) || null
}

/** 认领一次只交给一个成员。回执写 ttl_seconds 和 expires_at。凭证不含名称。 */
export function claimTask(project, { member_id, task_id, now, ttl_seconds, key, dryRun = false }) {
  if (!project) return { ok: false, error: '没有这个项目' }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(member_id || '')) return { ok: false, error: '成员 id 无效' }
  if (project.legacy_blocked) return { ok: false, error: '项目缺少 world_id，已阻止调度' }
  project.tasks = refreshTasks(project.tasks)
  const gate = executable(project.tasks, task_id)
  if (!gate.ok) return gate
  if (gate.task.status === 'running' || gate.task.status === 'checkpoint' || gate.task.status === 'reconciling') {
    return { ok: false, error: '任务已被认领或正在交接' }
  }
  if (activeClaim(project, task_id, now)) return { ok: false, error: '任务已被认领' }
  const ttl = ttl_seconds == null ? TTL_SECONDS : ttl_seconds
  if (!Number.isInteger(ttl) || ttl <= 0) return { ok: false, error: '期限无效' }
  const gen = (project.revocations?.[task_id] || 0) + 1
  if (dryRun) return { ok: true, task: gate.task, gen }
  const { cells, act } = cellsFor(project, gate.task)
  if (!act.length) return { ok: false, error: '这个任务没有可执行的动作' }
  let signed
  try {
    signed = signClaim({
      mid: member_id,
      tid: task_id,
      pid: project.id,
      bv: gate.task.blueprint_version || project.blueprint_version,
      gen,
      exp: now + ttl,
      act,
      cells,
    }, key)
  } catch (error) {
    return { ok: false, error: error.message }
  }
  if (signed.name || signed.code) return { ok: false, error: '凭证不能携带名称' }
  const claim = {
    ...signed,
    ttl_seconds: ttl,
    expires_at: new Date((now + ttl) * 1000).toISOString(),
    status: 'active',
  }
  claim.claimed_at = now
  claim.heartbeat_at = now
  claim.verified_progress_at = now
  project.claims.push(claim)
  gate.task.status = 'running'
  project.tasks = project.tasks.map((task) => (task.id === gate.task.id ? gate.task : task))
  return { ok: true, claim, project }
}

export function expireClaims(project, now) {
  for (const claim of project.claims) {
    if (claim.status === 'active' && claim.exp <= now) {
      claim.status = 'reconciling'
      beginReconciliation(project, claim.tid, { reason: 'lease_expired', now })
    }
  }
  project.tasks = refreshTasks(project.tasks)
  return project
}

export function usableClaim(project, taskId, now) {
  const active = project.claims.filter((item) => item.tid === taskId && item.status === 'active' && item.exp > now)
  if (!active.length) return { ok: false, error: '没有有效认领' }
  active.sort((a, b) => b.gen - a.gen)
  const claim = active[0]
  const revokedFloor = (project.revocations?.[taskId] || 0) + 1
  if (claim.gen < revokedFloor) return { ok: false, error: '认领代际已作废' }
  return { ok: true, claim }
}

export function revokeTask(project, taskId, key) {
  const active = project.claims.filter((claim) => claim.tid === taskId && claim.status === 'active')
  let gen = project.revocations?.[taskId] || 0
  for (const claim of active) {
    claim.status = 'revoked'
    gen = Math.max(gen, claim.gen)
  }
  project.revocations = { ...project.revocations, [taskId]: Math.max(gen, project.revocations?.[taskId] || 0) }
  const task = project.tasks.find((item) => item.id === taskId)
  if (task && task.status === 'running') task.status = 'reconciling'
  if (task && task.status === 'checkpoint') task.status = 'checkpoint'
  return {
    pid: project.id,
    tid: taskId,
    gen,
    sig: key ? signRevoke(project.id, taskId, gen, key) : null,
    cells: task ? task.cells.map(parseKey) : [],
  }
}
