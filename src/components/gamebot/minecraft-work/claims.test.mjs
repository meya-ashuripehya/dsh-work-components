import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorize } from './auth.mjs'
import { claimTask, expireClaims, usableClaim } from './claims.mjs'
import { canonical, signText } from './sign.mjs'
import { testSite } from './model.mjs'
import { createProject } from './project.mjs'
import { createStore } from './store.mjs'

const NOW = 1_700_000_000
const KEY = Buffer.from('test-claim-key')

function project() {
  return createProject(testSite(), { id: 'site', now: NOW, world_id: 'test-world', fill_test_stock: true })
}

test('并发认领只有一方成功；省略期限时回执为 900 秒；过期后不能执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-claim-'))
  try {
    const store = createStore(dir)
    store.write(project())
    const [a, b] = await Promise.all([
      store.update('site', async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return claimTask(current, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
      }),
      store.update('site', async (current) => claimTask(current, { member_id: 'beta', task_id: 'floor', now: NOW, key: KEY })),
    ])
    const won = [a, b].filter((item) => item.ok)
    assert.equal(won.length, 1)
    assert.equal(won[0].claim.ttl_seconds, 900)
    assert.equal(won[0].claim.expires_at, new Date((NOW + 900) * 1000).toISOString())
    assert.equal(won[0].claim.mid.length <= 32, true)
    assert.equal('name' in won[0].claim, false)
    const saved = store.read('site')
    assert.equal(saved.claims.filter((claim) => claim.status === 'active').length, 1)
    expireClaims(saved, NOW + 900)
    assert.match(usableClaim(saved, 'floor', NOW + 900).error, /没有有效认领/)
    assert.equal(saved.tasks.find((t) => t.id === 'floor').status, 'reconciling')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('32 字符 id 的规范串不超过 263 字节', () => {
  const id = 'a'.repeat(32)
  const text = canonical({
    mid: id, tid: id, pid: id, bv: 1, gen: 1, exp: 1_700_000_000,
    act: ['place', 'break'], cells: [{ x: 0, y: 64, z: 0 }],
  })
  assert.ok(Buffer.byteLength(text) <= 263, text.length + ' bytes: ' + text)
  const fixed = canonical({
    mid: 'alpha', tid: 'floor', pid: 'site', bv: 1, gen: 1, exp: 1_700_000_900,
    act: ['place'], cells: [{ x: 0, y: 64, z: 0 }],
  })
  assert.equal(fixed, 'v1|alpha|floor|site|1|1|1700000900|place|57afad8b711ae819e8d5bf8584d1999a16d5db23b70ad0f424ba1920206ab13b')
  assert.equal(signText(fixed, Buffer.from('test-claim-key')), 'ea759c111249978caa1b3512eb8c15007982bbf29e6b99d1f8128180da1ef9d3')
})

test('门洞和工地外的坐标不能拆、不能放', () => {
  const current = project()
  const claimed = claimTask(current, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  assert.equal(authorize(claimed.project, claimed.claim, { x: 0, y: 64, z: 0 }, 'place').ok, true)
  assert.match(authorize(claimed.project, claimed.claim, { x: 9, y: 64, z: 9 }, 'place').error, /不在认领凭证里/)
  const wall = claimed.project
  wall.tasks.find((task) => task.id === 'floor').status = 'done'
  wall.tasks.find((task) => task.id === 'front').status = 'claimable'
  const door = claimTask(wall, { member_id: 'alpha', task_id: 'front', now: NOW, key: KEY })
  assert.match(authorize(door.project, door.claim, { x: 2, y: 65, z: 0 }, 'break').error, /没有拆除许可/)
})
