import { refreshTasks } from './tasks.mjs'
import { activeClaim } from './claims.mjs'

/** 到达检查点后必须有一次继续调用。时钟不能让任务往后走。 */
export function markCheckpoint(project, taskId) {
  const task = project.tasks.find((item) => item.id === taskId)
  if (!task) return { ok: false, error: '没有这个任务' }
  task.status = 'checkpoint'
  project.loop.phase = 'checkpoint'
  project.journal.push({ kind: 'checkpoint', task_id: taskId })
  return { ok: true, project }
}

export function continueTask(project, { task_id, member_id, now }) {
  const task = project.tasks.find((item) => item.id === task_id)
  if (!task || task.status !== 'checkpoint') return { ok: false, error: '不在检查点' }
  const claim = activeClaim(project, task_id, now)
  if (!claim || claim.mid !== member_id) return { ok: false, error: '不是认领人' }
  task.status = 'done'
  project.tasks = refreshTasks(project.tasks)
  project.loop.phase = project.tasks.some((item) => item.status === 'claimable' || item.status === 'running') ? 'running' : 'done'
  project.journal.push({ kind: 'continue', task_id, member_id, at: now })
  return { ok: true, project }
}

export function nextReady(project) {
  return project.tasks.find((task) => task.status === 'running') || null
}
