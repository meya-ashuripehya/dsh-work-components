import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserve } from './materials.mjs'
import { testSite } from './model.mjs'
import { createProject } from './project.mjs'
import { createStore } from './store.mjs'

test('同一缺口并发领取只有一笔成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-mat-'))
  try {
    const store = createStore(dir)
    const project = createProject(testSite(), { id: 'site', now: 1, world_id: 'test-world' })
    project.materials.items['minecraft:oak_log'] = { stock: 64, reserved: 0, in_transit: 0, carried: {}, gap: 64, grants: [] }
    store.write(project)
    const [a, b] = await Promise.all([
      store.update('site', async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return reserve(current, { member_id: 'alpha', item_id: 'minecraft:oak_log', qty: 64, now: 1 })
      }),
      store.update('site', (current) => reserve(current, { member_id: 'beta', item_id: 'minecraft:oak_log', qty: 64, now: 1 })),
    ])
    assert.equal([a, b].filter((item) => item.ok).length, 1)
    assert.equal(store.read('site').materials.items['minecraft:oak_log'].reserved, 64)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
