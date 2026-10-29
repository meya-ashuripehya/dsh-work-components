import { parseKey, posKey } from './model.mjs'
import { cellAt } from './materials.mjs'
import { classifyCell } from './reconcile.mjs'
import { refreshTasks } from './tasks.mjs'

function dependentsOf(tasks, roots) {
  const extra = new Set(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const task of tasks) {
      if (extra.has(task.id)) continue
      if (task.depends_on.some((id) => extra.has(id))) {
        extra.add(task.id)
        grew = true
      }
    }
  }
  return extra
}

function thaw(project) {
  const frozenCells = new Set(project.conflicts.filter((item) => item.status === 'frozen').map((item) => item.pos))
  const roots = new Set()
  for (const cell of project.cells) {
    if (frozenCells.has(posKey(cell))) roots.add(cell.part_id)
  }
  const frozenTasks = dependentsOf(project.tasks, roots)
  for (const task of project.tasks) {
    if (task.status === 'done') continue
    if (frozenTasks.has(task.id)) task.status = 'frozen'
    else if (task.status === 'frozen') task.status = 'claimable'
  }
  project.tasks = refreshTasks(project.tasks)
}

/** 开工前对账。不一致的格子和依赖它的任务冻结，时间过去也不会解除。 */
export function diffSite(project, snapshot, now) {
  const found = []
  for (const cell of project.cells) {
    if (cell.kind === 'out_of_scope') continue
    const key = posKey(cell)
    if (project.progress.done.includes(key)) continue
    const seen = snapshot.radius == null ? (snapshot.blocks || []).find((block) => posKey(block) === key)?.block_id || 'minecraft:air' : classifyCell(cell, snapshot)
    if (seen === 'unknown') {
      found.push({ pos: key, reason: '未知', block_id: null, status: 'frozen', since: now })
      continue
    }
    if (cell.kind === 'required_empty' && seen !== 'minecraft:air') {
      found.push({ pos: key, reason: '必须为空的位置上已有方块', block_id: seen, status: 'frozen', since: now })
    } else if (cell.kind === 'specified' && seen !== 'minecraft:air' && seen !== cell.block_id) {
      found.push({ pos: key, reason: '现场方块与图纸不一致', block_id: seen, status: 'frozen', since: now })
    }
  }
  project.conflicts.push(...found)
  thaw(project)
  return { conflicts: found, frozen: project.tasks.filter((task) => task.status === 'frozen').map((task) => task.id) }
}

/** 只记录等待时间，不把冻结改成通过。 */
export function waitLonger(project, now) {
  for (const item of project.conflicts) {
    if (item.status === 'frozen') item.waiting_until = now
  }
  return project.conflicts.filter((item) => item.status === 'frozen')
}

export function decideConflict(project, { pos, decision, now }) {
  const key = typeof pos === 'string' ? pos : posKey(pos)
  const open = project.conflicts.filter((item) => item.pos === key && item.status === 'frozen')
  if (!open.length) return { ok: false, error: '没有待处理的冲突' }
  const cell = cellAt(project, key)
  if (!cell) return { ok: false, error: '坐标不在图纸里' }
  if (decision === 'accept_site') {
    cell.kind = 'specified'
    cell.block_id = open[0].block_id
    cell.grants_break = false
    project.blueprint_version += 1
    project.progress.done.push(key)
  } else if (decision === 'authorize_restore') {
    cell.grants_break = true
  } else if (decision === 'exclude') {
    cell.kind = 'out_of_scope'
    cell.block_id = null
    cell.grants_break = false
    project.progress.done.push(key)
  } else {
    return { ok: false, error: '决定无效' }
  }
  for (const item of open) {
    item.status = 'resolved'
    item.decision = decision
    item.resolved_at = now
  }
  thaw(project)
  return { ok: true, project }
}

export function frozenTaskIds(project) {
  return project.tasks.filter((task) => task.status === 'frozen').map((task) => task.id)
}

export { parseKey }
