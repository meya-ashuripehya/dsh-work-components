import test from 'node:test'
import assert from 'node:assert/strict'
import { claimTask } from './claims.mjs'
import { handoff, revise } from './handoff.mjs'
import { testSite } from './model.mjs'
import { createProject } from './project.mjs'

const NOW = 1_700_000_000
const KEY = Buffer.from('k')

test('在途结果未知时拒绝新认领；只改门洞时平台凭证仍有效', () => {
  const project = createProject(testSite(), { id: 'site', now: NOW, world_id: 'test-world', fill_test_stock: true })
  const floor = claimTask(project, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  floor.project.inflight.push({ operation_id: 'op-1', task_id: 'floor', member_id: 'alpha', status: 'unknown', sent: true })
  const blocked = handoff(floor.project, { task_id: 'floor', to: 'beta', now: NOW, key: KEY })
  assert.match(blocked.error, /未知/)
  assert.equal(blocked.project.claims.filter((claim) => claim.status === 'active' && claim.tid === 'floor').length, 1)
  floor.project.inflight[0].status = 'settled'
  floor.project.tasks.find((task) => task.id === 'floor').status = 'done'
  const revised = revise(floor.project, { cell_keys: ['2,65,0'], now: NOW })
  assert.equal(revised.kept.includes('floor'), true)
  assert.equal(revised.revoked.includes('floor'), false)
  const wall = claimTask(revised.project, { member_id: 'alpha', task_id: 'front', now: NOW, key: KEY })
  assert.equal(wall.ok, true)
  const again = revise(wall.project, { cell_keys: ['2,65,0'], now: NOW })
  assert.equal(again.revoked.includes('front'), true)
  assert.equal(again.kept.includes('floor'), true)
})
