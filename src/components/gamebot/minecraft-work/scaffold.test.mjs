import test from 'node:test'
import assert from 'node:assert/strict'
import { addScaffold, requestRemove } from './scaffold.mjs'
import { admit } from './traffic.mjs'
import { mergeMeets, shouldChase } from './meet.mjs'
import { createProject } from './project.mjs'
import { testSite } from './model.mjs'

test('有人使用或仍被依赖时不拆脚手架', () => {
  const project = createProject(testSite(), { id: 'site', now: 1 })
  const busy = addScaffold(project, { id: 's1', x: 1, y: 65, z: -1, users: ['alpha'], dependents: [] })
  assert.match(requestRemove(busy).error, /仍有人使用/)
  busy.users = []
  busy.dependents = ['front']
  assert.match(requestRemove(busy).error, /仍依赖/)
  busy.dependents = []
  assert.equal(requestRemove(busy).ok, true)
})

test('同一格只有一步可以写', () => {
  const result = admit([
    { member_id: 'alpha', pos: { x: 1, y: 64, z: 1 } },
    { member_id: 'beta', pos: { x: 1, y: 64, z: 1 } },
  ])
  assert.deepEqual(result.map((item) => item.result), ['go', 'yield'])
})

test('双向会合合并后，对方挪一格不再追', () => {
  const meeting = mergeMeets(
    { member: 'alpha', target: 'beta', pos: { x: 0, y: 64, z: 0 } },
    { member: 'beta', target: 'alpha', pos: { x: 4, y: 64, z: 0 } },
  )
  assert.equal(meeting.ok, true)
  assert.deepEqual(meeting.point, { x: 2, y: 64, z: 0 })
  assert.equal(meeting.stands.length, 2)
  assert.equal(shouldChase(true, { x: 1, y: 0, z: 0 }), false)
  assert.equal(shouldChase(false, { x: 1, y: 0, z: 0 }), true)
})
