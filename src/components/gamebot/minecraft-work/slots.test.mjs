import test from 'node:test'
import assert from 'node:assert/strict'
import { assignMembers } from './assign.mjs'
import { interrupt, occupying, resolveUnknown } from './slots.mjs'
import { createProject } from './project.mjs'
import { testSite } from './model.mjs'

test('五个成员里同一工地最多两人施工，其余去不重叠的非施工任务', () => {
  const project = createProject(testSite(), { id: 'site', now: 1 })
  project.tasks.find((task) => task.id === 'floor').status = 'done'
  project.tasks.find((task) => task.id === 'front').status = 'claimable'
  project.tasks.push(
    { id: 'wing', kind: 'build', depends_on: [], status: 'claimable', checkpoint: true, cells: ['10,64,0'], pos: { x: 10, y: 64, z: 0 } },
    { id: 'logs', kind: 'gather', depends_on: [], status: 'claimable', checkpoint: false, cells: [], pos: { x: 30, y: 64, z: 0 } },
    { id: 'haul', kind: 'haul', depends_on: [], status: 'claimable', checkpoint: false, cells: [], pos: { x: 40, y: 64, z: 4 } },
    { id: 'pole', kind: 'scaffold', depends_on: [], status: 'claimable', checkpoint: false, cells: [], pos: { x: 50, y: 65, z: 2 } },
  )
  const members = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, pos: { x: index, y: 64, z: 0 }, idle: index, queue: index }))
  const result = assignMembers(project, members)
  assert.equal(result.build_count, 2)
  assert.equal(result.assigned.length, 5)
  assert.equal(result.unique_positions, true)
  assert.equal(result.assigned.filter((item) => item.role !== 'build').length, 3)
})

test('打断后旧动作进入未知清单且不重放，并发名额不被突破', () => {
  const project = createProject(testSite(), { id: 'site', now: 1 })
  project.inflight.push({ operation_id: 'old', member_id: 'alpha', status: 'inflight', sent: true, kind: 'build', task_id: 'floor', replay: false })
  const result = interrupt(project, project.inflight, {
    member_id: 'alpha',
    sent: true,
    next: { operation_id: 'new', task_id: 'floor', kind: 'build' },
  })
  assert.equal(result.dispatched, false)
  assert.equal(result.replay, false)
  assert.equal(project.unknown[0].operation_id, 'old')
  assert.equal(project.unknown[0].replay, false)
  assert.equal(occupying(project.inflight).length, 1)
  const settled = resolveUnknown(project, 'old')
  assert.equal(settled.replay, false)
  assert.equal(occupying(project.inflight).length, 0)
  const global = Array.from({ length: 6 }, (_, index) => ({ operation_id: `g${index}`, member_id: `m${index}`, status: 'unknown', kind: 'gather' }))
  const blocked = interrupt(project, global, { member_id: 'beta', sent: false, next: { operation_id: 'later', task_id: 'logs', kind: 'gather' } })
  assert.equal(blocked.dispatched, false)
  assert.match(blocked.reason, /全局在途已满/)
})
