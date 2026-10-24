import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBuiltJar, installJar, minaretSourceDir, normalizeModsDir, proxyProps, sourceHash } from './minaret.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'minaret-test-'))

test('normalizeModsDir：游戏目录、实例目录归到 mods', () => {
  const base = tmp()
  try {
    const mods = join(base, 'a', 'mods')
    mkdirSync(mods, { recursive: true })
    assert.equal(normalizeModsDir(mods), mods)
    assert.equal(normalizeModsDir(join(base, 'a')), mods)

    mkdirSync(join(base, 'game', 'versions'), { recursive: true })
    assert.equal(normalizeModsDir(join(base, 'game')), join(base, 'game', 'mods'))

    mkdirSync(join(base, 'inst', 'minecraft'), { recursive: true })
    assert.equal(normalizeModsDir(join(base, 'inst')), join(base, 'inst', 'minecraft', 'mods'))

    mkdirSync(join(base, 'plain'))
    assert.equal(normalizeModsDir(join(base, 'plain')), join(base, 'plain'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('installJar：旧版先备份再替换，同名覆盖也留备份', async () => {
  const base = tmp()
  try {
    const mods = join(base, 'Instance', 'mods')
    mkdirSync(mods, { recursive: true })
    writeFileSync(join(mods, 'minaret-0.9.0.jar'), 'old')
    writeFileSync(join(mods, 'other.jar'), 'keep')
    const jar = join(base, 'minaret-1.0.0.jar')
    writeFileSync(jar, 'new')

    await assert.rejects(() => installJar(jar, ''), (e) => e.status === 400)

    const first = await installJar(jar, join(base, 'Instance'))
    assert.equal(first.modsDir, mods)
    assert.equal(readFileSync(join(mods, 'minaret-1.0.0.jar'), 'utf8'), 'new')
    assert.equal(readFileSync(join(mods, 'other.jar'), 'utf8'), 'keep')
    let names = readdirSync(mods)
    assert.ok(!names.includes('minaret-0.9.0.jar'))
    assert.ok(names.some((n) => n.startsWith('minaret-0.9.0.jar.bak-')))

    await installJar(jar, mods)
    names = readdirSync(mods)
    assert.ok(names.some((n) => n.startsWith('minaret-1.0.0.jar.bak-')))
    assert.equal(readFileSync(join(mods, 'minaret-1.0.0.jar'), 'utf8'), 'new')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('findBuiltJar 忽略 sources / 备份', () => {
  const base = tmp()
  try {
    assert.equal(findBuiltJar(join(base, 'none')), null)
    writeFileSync(join(base, 'minaret-1.0.0-sources.jar'), 'x')
    writeFileSync(join(base, 'minaret-1.0.0.jar.bak-1'), 'x')
    assert.equal(findBuiltJar(base), null)
    writeFileSync(join(base, 'minaret-1.0.0.jar'), 'x')
    assert.equal(findBuiltJar(base), join(base, 'minaret-1.0.0.jar'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('proxyProps：代理 URL 转 Java 系统属性', () => {
  assert.deepEqual(proxyProps(''), [])
  const props = Object.fromEntries(proxyProps('http://127.0.0.1:7890'))
  assert.equal(props['https.proxyHost'], '127.0.0.1')
  assert.equal(props['https.proxyPort'], '7890')
  assert.equal(props['http.proxyPort'], '7890')
  assert.equal(Object.fromEntries(proxyProps('127.0.0.1:1080'))['http.proxyHost'], '127.0.0.1')
})

test('包内自带的模组源码：存在、哈希稳定且不含构建产物 / 测试', () => {
  const src = minaretSourceDir(here.replace(/[\\/]$/, ''))
  const a = sourceHash(src)
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(sourceHash(src), a)
  assert.ok(readFileSync(join(src, 'build.gradle'), 'utf8').includes('net.neoforged.moddev'))
  assert.ok(readFileSync(join(src, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8').includes('gradle-8.8'))
})
