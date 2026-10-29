import test from 'node:test'
import assert from 'node:assert/strict'
import { claimTask } from './claims.mjs'
import { decideConflict, diffSite, waitLonger } from './conflicts.mjs'
import { continueTask } from './checkpoints.mjs'
import { testSite } from './model.mjs'
import { createProject } from './project.mjs'

const NOW = 1_700_000_000
const KEY = Buffer.from('k')

test('门洞箱子冻结墙任务，平台仍可执行；超时不解除冻结', () => {
  const project = createProject(testSite(), { id: 'site', now: NOW, world_id: 'test-world' })
  const result = diffSite(project, { blocks: [{ x: 2, y: 65, z: 0, block_id: 'minecraft:chest' }] }, NOW)
  assert.equal(result.frozen.includes('front'), true)
  assert.equal(result.frozen.includes('floor'), false)
  assert.equal(project.tasks.find((task) => task.id === 'floor').status, 'claimable')
  waitLonger(project, NOW + 86_400)
  assert.equal(project.conflicts.every((item) => item.status === 'frozen'), true)
  const decided = decideConflict(project, { pos: '2,65,0', decision: 'exclude', now: NOW + 10 })
  assert.equal(decided.ok, true)
  assert.equal(project.conflicts[0].status, 'resolved')
  assert.equal(project.tasks.find((task) => task.id === 'front').status, 'blocked')
})

test('没有继续调用时，检查点之后不会把任务标完成', () => {
  const project = createProject(testSite(), { id: 'site', now: NOW, world_id: 'test-world' })
  const claimed = claimTask(project, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  assert.equal(claimed.ok, true)
  claimed.project.tasks.find((task) => task.id === 'floor').status = 'checkpoint'
  claimed.project.loop.phase = 'checkpoint'
  const skipped = continueTask(claimed.project, { task_id: 'floor', member_id: 'beta', now: NOW })
  assert.match(skipped.error, /不是认领人/)
  assert.equal(claimed.project.tasks.find((task) => task.id === 'floor').status, 'checkpoint')
  const next = continueTask(claimed.project, { task_id: 'floor', member_id: 'alpha', now: NOW })
  assert.equal(next.ok, true)
  assert.equal(next.project.tasks.find((task) => task.id === 'floor').status, 'done')
  assert.equal(next.project.tasks.find((task) => task.id === 'front').status, 'claimable')
})
