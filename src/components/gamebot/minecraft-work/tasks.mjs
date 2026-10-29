/** 一面平台或一面墙一个任务。墙依赖全部平台。前置未完成的任务不可执行。 */

export function tasksFrom(expanded) {
  const platforms = expanded.parts.filter((part) => part.kind === 'platform').map((part) => part.id)
  const tasks = []
  for (const part of expanded.parts) {
    if (part.kind !== 'platform' && part.kind !== 'wall' && part.kind !== 'block') continue
    const cells = expanded.cells.filter((cell) => cell.part_id === part.id).map((cell) => `${cell.x},${cell.y},${cell.z}`)
    let depends = []
    if (part.kind === 'wall') depends = [...platforms]
    else if (part.kind === 'block') depends = Array.isArray(part.depends_on) ? [...part.depends_on] : []
    tasks.push({
      id: part.id,
      kind: 'build',
      depends_on: depends,
      status: 'claimable',
      checkpoint: part.kind === 'block' ? false : true,
      blueprint_version: 1,
      cells,
      pos: cells[0] ? posOf(cells[0]) : { x: 0, y: 0, z: 0 },
    })
  }
  return refreshTasks(tasks)
}

function posOf(key) {
  const [x, y, z] = key.split(',').map(Number)
  return { x, y, z }
}

export function refreshTasks(tasks) {
  return tasks.map((task) => {
    if (task.status === 'done' || task.status === 'running' || task.status === 'checkpoint' || task.status === 'frozen' || task.status === 'reconciling') return task
    const unmet = task.depends_on.some((id) => tasks.find((item) => item.id === id)?.status !== 'done')
    return { ...task, status: unmet ? 'blocked' : 'claimable' }
  })
}

export function executable(tasks, taskId) {
  const task = tasks.find((item) => item.id === taskId)
  if (!task) return { ok: false, error: '没有这个任务' }
  if (task.status === 'blocked') return { ok: false, error: '前置未完成' }
  if (task.status === 'frozen') return { ok: false, error: '任务已冻结' }
  if (task.status === 'done') return { ok: false, error: '任务已完成' }
  return { ok: true, task }
}
