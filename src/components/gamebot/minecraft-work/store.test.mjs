import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitJson, createStore } from './store.mjs'

test('替换失败时原项目文件保持上一份，损坏文件不会被覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-work-'))
  try {
    const store = createStore(dir)
    store.write({ id: 'site', version: 1 })
    const file = store.pathOf('site')
    assert.throws(() => commitJson(file, { id: 'site', version: 2 }, {
      writeFileSync,
      renameSync() { throw new Error('disk') },
      rmSync,
    }))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
    assert.equal(existsSync(`${file}.${process.pid}.tmp`), false)
    writeFileSync(file, '{', 'utf8')
    assert.throws(() => store.read('site'), /损坏/)
    assert.equal(readFileSync(file, 'utf8'), '{')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
