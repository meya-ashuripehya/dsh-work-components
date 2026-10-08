/**
 * 本地兼容冒烟：用 fixtures/local-stub 作为 DSH_WORKBENCH_LOCAL_COMPONENTS_DIR，
 * 验证 registry 合并、moduleSource、contribute 清单；不 commit、不联网。
 */
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const stubSrc = join(root, 'fixtures', 'local-stub')
const tmpLocal = join(root, 'lib', '.localcomp-smoke-dir')

if (!existsSync(join(stubSrc, 'demo-local', 'index.mjs'))) {
  throw new Error('missing fixtures/local-stub/demo-local')
}

rmSync(tmpLocal, { recursive: true, force: true })
mkdirSync(tmpLocal, { recursive: true })
cpSync(stubSrc, tmpLocal, { recursive: true })
process.env.DSH_WORKBENCH_LOCAL_COMPONENTS_DIR = tmpLocal

// 动态加载源码 registry（构建前也可测）；构建后也可从 lib 测。
const registryUrl = pathToFileURL(join(root, 'src', 'components', 'registry.mjs')).href
const reg = await import(registryUrl)

const ids = reg.COMPONENTS.map((c) => c.id)
const bundled = reg.COMPONENTS.filter((c) => c.moduleSource === 'bundled')
const local = reg.COMPONENTS.filter((c) => c.moduleSource === 'local')

console.log('components:', ids.join(', '))
console.log('bundled:', bundled.map((c) => c.id).join(', '))
console.log('local:', local.map((c) => c.id).join(', '))
console.log('localComponentsDir:', reg.localComponentsDir())

if (!ids.includes('office') || !ids.includes('demo-local')) {
  throw new Error('expected office (bundled) and demo-local (local) in COMPONENTS')
}
const demo = reg.componentById('demo-local')
if (!demo || demo.moduleSource !== 'local') throw new Error('demo-local not marked local')
const office = reg.componentById('office')
if (!office || office.moduleSource !== 'bundled') throw new Error('office not marked bundled')

const info = reg.contributeInfo('demo-local')
if (!info?.checklist || !info.compareUrl) throw new Error('contributeInfo missing')
if (reg.contributeInfo('office')) throw new Error('office must not have contributeInfo')

// Isolation: process.exit / tight loop in local modules must not kill this host process.
const evilRoot = join(root, 'lib', '.localcomp-isolation-dir')
rmSync(evilRoot, { recursive: true, force: true })
mkdirSync(join(evilRoot, 'evil-exit'), { recursive: true })
mkdirSync(join(evilRoot, 'evil-loop'), { recursive: true })
writeFileSync(join(evilRoot, 'evil-exit', 'index.mjs'), 'process.exit(0)\n')
writeFileSync(join(evilRoot, 'evil-loop', 'index.mjs'), 'while (true) {}\n')
const warns = []
const isolated = await reg.discoverLocalComponents({ dir: evilRoot, log: (m) => warns.push(String(m)) })
if (isolated.length !== 0) throw new Error('evil local modules must not register')
if (!warns.some((w) => w.includes('evil-exit'))) throw new Error('expected warn for evil-exit')
if (!warns.some((w) => w.includes('evil-loop'))) throw new Error('expected warn for evil-loop')
console.log('isolation ok:', warns.map((w) => w.slice(0, 120)).join(' | '))

reg.disposeLocalComponents?.()

console.log('contribute files:', (info.files || []).join(', ') || '(none)')
console.log('compareUrl:', info.compareUrl)

const out = join(root, 'lib', 'localcomp-smoke.json')
writeFileSync(out, JSON.stringify({
  ok: true,
  ids,
  bundled: bundled.map((c) => c.id),
  local: local.map((c) => c.id),
  contribute: { id: info.id, files: info.files, compareUrl: info.compareUrl },
}, null, 2))
console.log('wrote', out)
