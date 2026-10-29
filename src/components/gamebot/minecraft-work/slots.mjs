import { GLOBAL_INFLIGHT, MEMBER_INFLIGHT, PROJECT_BUILD_INFLIGHT } from './model.mjs'

export const LIMITS = {
  member: MEMBER_INFLIGHT,
  projectBuild: PROJECT_BUILD_INFLIGHT,
  global: GLOBAL_INFLIGHT,
}

export function occupying(list) {
  return (list || []).filter((item) => item.status === 'inflight' || item.status === 'unknown')
}

export function buildOccupying(project) {
  return occupying(project.inflight).filter((item) => item.kind !== 'gather' && item.kind !== 'haul' && item.kind !== 'scaffold')
}

export function canDispatch(project, globalInflight, entry) {
  const mine = occupying(project.inflight).filter((item) => item.member_id === entry.member_id)
  if (mine.length >= LIMITS.member) return { ok: false, error: '该成员已有在途动作' }
  const build = entry.kind === 'build' || !entry.kind
  if (build && buildOccupying(project).length >= LIMITS.projectBuild) return { ok: false, error: '该工地动手名额已满' }
  if (occupying(globalInflight).length >= LIMITS.global) return { ok: false, error: '全局在途已满' }
  return { ok: true }
}

/**
 * 新指令替换当前动作。已发出的旧动作记为未知并继续占坑，新动作不因此超限。
 * 未知项不会被自动重放。
 */
export function interrupt(project, globalInflight, { member_id, sent, next }) {
  const operation = {
    operation_id: next.operation_id,
    member_id,
    task_id: next.task_id,
    kind: next.kind || 'build',
    project_id: project.id,
    status: 'pending',
    sent: false,
    replay: false,
  }
  const current = project.inflight.find((item) => item.member_id === member_id && (item.status === 'inflight' || item.status === 'unknown'))
  if (current && (current.sent || sent)) {
    current.status = 'unknown'
    current.replay = false
    if (!project.unknown.some((item) => item.operation_id === current.operation_id)) project.unknown.push(current)
    project.replacements.push(operation)
    return { dispatched: false, unknown: current.operation_id, operation_id: operation.operation_id, replay: false }
  }
  if (current) current.status = 'cancelled'
  const gate = canDispatch(project, globalInflight, operation)
  if (!gate.ok) return { dispatched: false, reason: gate.error, operation_id: operation.operation_id }
  operation.status = 'inflight'
  project.inflight.push(operation)
  return { dispatched: true, operation_id: operation.operation_id }
}

export function resolveUnknown(project, operationId) {
  const item = project.inflight.find((entry) => entry.operation_id === operationId && entry.status === 'unknown')
  if (!item) return { ok: false, error: '没有这条未知动作' }
  item.status = 'settled'
  item.replay = false
  return { ok: true, replay: false, project }
}
