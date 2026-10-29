import test from 'node:test'
import assert from 'node:assert/strict'
import { authorize } from './auth.mjs'
import { claimTask } from './claims.mjs'
import { testSite } from './model.mjs'
import { createProject } from './project.mjs'

test('工地外拒绝，门洞在未授予拆除时拒绝拆除', () => {
  const project = createProject(testSite(), { id: 'site', now: 10, world_id: 'test-world' })
  const floor = claimTask(project, { member_id: 'alpha', task_id: 'floor', now: 10, key: Buffer.from('k') })
  assert.equal(floor.ok, true)
  assert.match(authorize(floor.project, floor.claim, { x: 30, y: 64, z: 30 }, 'break').error, /不在认领凭证里|不在图纸里/)
  floor.project.tasks.find((task) => task.id === 'floor').status = 'done'
  floor.project.tasks.find((task) => task.id === 'front').status = 'claimable'
  const wall = claimTask(floor.project, { member_id: 'alpha', task_id: 'front', now: 10, key: Buffer.from('k') })
  assert.match(authorize(wall.project, wall.claim, { x: 2, y: 65, z: 0 }, 'break').error, /没有拆除许可/)
})
