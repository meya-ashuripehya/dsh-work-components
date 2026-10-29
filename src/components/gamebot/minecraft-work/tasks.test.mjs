import test from 'node:test'
import assert from 'node:assert/strict'
import { expand } from './blueprint.mjs'
import { testSite } from './model.mjs'
import { executable, tasksFrom } from './tasks.mjs'

test('平台未完成时墙任务不能执行', () => {
  const tasks = tasksFrom(expand(testSite()))
  assert.equal(tasks.find((task) => task.id === 'floor').status, 'claimable')
  assert.equal(tasks.find((task) => task.id === 'front').status, 'blocked')
  assert.match(executable(tasks, 'front').error, /前置未完成/)
  assert.equal(executable(tasks, 'floor').ok, true)
})
