import test from 'node:test'
import assert from 'node:assert/strict'
import { acknowledgeSettled, addNote, requestStop } from './control.mjs'
import { createProject } from './project.mjs'
import { testSite } from './model.mjs'

test('备注不改变执行；停止先收到，在途结束后才停稳', () => {
  const project = createProject(testSite(), { id: 'site', now: 1 })
  project.control.execution = 'running'
  project.inflight.push({ operation_id: 'op-1', status: 'inflight', sent: true, task_id: 'floor' })
  const noted = addNote(project, '随便聊聊')
  assert.equal(noted.execution, 'running')
  assert.equal(noted.stop, null)
  const stop = requestStop(project, 2)
  assert.equal(stop.received, true)
  assert.equal(stop.stopped, false)
  assert.equal(stop.stop.phase, 'received')
  assert.equal(project.unknown[0].replay, false)
  const done = acknowledgeSettled(project, 'op-1', 3)
  assert.equal(done.phase, 'stopped')
  assert.equal(project.control.execution, 'stopped')
})
