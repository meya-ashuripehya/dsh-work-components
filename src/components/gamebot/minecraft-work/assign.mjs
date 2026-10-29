import { distance, parseKey } from './model.mjs'
import { LIMITS } from './slots.mjs'

function ready(tasks, task) {
  return task.depends_on.every((id) => tasks.find((item) => item.id === id)?.status === 'done')
}

function taskPos(task) {
  if (task.pos) return task.pos
  return task.cells?.length ? parseKey(task.cells[0]) : { x: 0, y: 0, z: 0 }
}

/**
 * 依赖就绪优先，然后就近、空闲更久、更早入队。
 * 每个工地最多两个施工名额，其余成员改派到坐标不同的非施工任务。
 */
export function assignMembers(project, members) {
  const used = new Set(project.assignments.map((item) => item.task_id))
  const buildTasks = project.tasks.filter((task) => task.kind === 'build' && task.status === 'claimable' && ready(project.tasks, task))
  const otherTasks = project.tasks.filter((task) => task.kind !== 'build' && task.status === 'claimable' && ready(project.tasks, task))
  const ranked = [...members].sort((a, b) => (b.idle || 0) - (a.idle || 0) || (a.queue || 0) - (b.queue || 0))
  const assigned = []
  let builds = project.inflight.filter((item) => (item.status === 'inflight' || item.status === 'unknown') && item.kind !== 'gather' && item.kind !== 'haul' && item.kind !== 'scaffold').length
  for (const member of ranked) {
    const pool = builds < LIMITS.projectBuild ? [...buildTasks, ...otherTasks] : otherTasks
    const open = pool.filter((task) => !used.has(task.id) && !assigned.some((item) => item.task_id === task.id))
    open.sort((a, b) => {
      const buildBias = (a.kind === 'build' ? 0 : 1) - (b.kind === 'build' ? 0 : 1)
      if (builds < LIMITS.projectBuild && buildBias) return buildBias
      return distance(member.pos, taskPos(a)) - distance(member.pos, taskPos(b))
    })
    const task = open[0]
    if (!task) continue
    if (task.kind === 'build') builds += 1
    assigned.push({ member_id: member.id, task_id: task.id, role: task.kind, pos: taskPos(task) })
  }
  const positions = assigned.map((item) => `${item.pos.x},${item.pos.y},${item.pos.z}`)
  project.assignments = assigned
  return { assigned, unique_positions: new Set(positions).size === positions.length, build_count: assigned.filter((item) => item.role === 'build').length }
}
