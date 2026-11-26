import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STATUS,
  assertManifestAsset,
  brokerState,
  installBroker,
  loadManifest,
  manifestPath,
  packageRootFrom,
} from './broker-install.mjs'
import { fillManifest } from '../../../scripts/stage-broker-asset.mjs'

function sums(buf) {
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    sha512: createHash('sha512').update(buf).digest('hex'),
  }
}

function manifestFor(buf, url = 'https://github.com/meya-ashuripehya/dsh-work-components/releases/download/v0.4.4/DSHDesktopBroker-win-x64.exe') {
  return {
    version: '0.4.4',
    assets: { 'win32-x64': { url, bytes: buf.length, ...sums(buf) } },
  }
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-broker-'))
}

test('loadManifest reads the manifest from the package root, not from beside the module', async () => {
  const dir = await tempDir()
  const nested = join(dir, 'src', 'components', 'desktop')
  await mkdir(nested, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-work-components', version: '0.4.4' }))
  const body = {
    version: '9.9.9',
    assets: {
      'win32-x64': {
        url: 'https://github.com/meya-ashuripehya/dsh-work-components/releases/download/v9.9.9/DSHDesktopBroker-win-x64.exe',
        sha256: 'a'.repeat(64),
        sha512: 'b'.repeat(128),
        bytes: 1,
      },
    },
  }
  await writeFile(join(nested, 'broker-manifest.json'), JSON.stringify(body))
  assert.equal(manifestPath(dir).replaceAll('\\', '/').endsWith('src/components/desktop/broker-manifest.json'), true)
  assert.equal(loadManifest(dir).version, '9.9.9')
  assert.equal(packageRootFrom(join(nested, 'broker-install.mjs')), dir)
  assert.equal(packageRootFrom(join(dir, 'lib', 'index.mjs')), dir)
  await rm(dir, { recursive: true, force: true })
})

test('repository manifest is an unhashed template and refuses download', () => {
  const manifest = loadManifest()
  const asset = manifest.assets['win32-x64']
  assert.equal(manifest.status, 'unavailable')
  assert.equal(asset.sha256, '')
  assert.equal(asset.sha512, '')
  assert.equal(asset.bytes, null)
  assert.match(asset.url, /^https:\/\/github\.com\/meya-ashuripehya\/dsh-work-components\/releases\/download\/v0\.4\.4\//)
  assert.throws(() => assertManifestAsset(asset), /sha256/)
})

test('http urls and missing hashes never call download', async () => {
  let called = 0
  const download = async () => { called++ }
  const httpDir = await tempDir()
  const emptyDir = await tempDir()
  await assert.rejects(() => installBroker({
    manifest: { version: '0.4.4', assets: { 'win32-x64': { url: 'http://github.com/a.exe', sha256: 'a'.repeat(64), sha512: 'b'.repeat(128) } } },
    dataDir: httpDir,
    platform: 'win32',
    arch: 'x64',
    download,
  }), /HTTPS/)
  await assert.rejects(() => installBroker({
    manifest: { version: '0.4.4', assets: { 'win32-x64': { url: 'https://github.com/a.exe', sha256: '', sha512: '' } } },
    dataDir: emptyDir,
    platform: 'win32',
    arch: 'x64',
    download,
  }), /sha256/)
  assert.equal(called, 0)
  await rm(httpDir, { recursive: true, force: true })
  await rm(emptyDir, { recursive: true, force: true })
})

test('a verified download becomes ready and a bad hash keeps the previous exe', async () => {
  const dir = await tempDir()
  const payload = Buffer.from('broker-bytes-' + 'x'.repeat(32))
  const manifest = manifestFor(payload)
  const download = async (_url, dest) => { await writeFile(dest, payload) }
  const installed = await installBroker({ manifest, dataDir: dir, platform: 'win32', arch: 'x64', download })
  assert.equal(await readFile(installed.exe, 'utf8'), payload.toString())
  assert.equal(brokerState({ dataDir: dir, manifest, platform: 'win32', arch: 'x64' }).state, STATUS.READY)

  const bad = async (_url, dest) => { await writeFile(dest, Buffer.from('tampered')) }
  await assert.rejects(
    () => installBroker({ manifest, dataDir: dir, platform: 'win32', arch: 'x64', download: bad }),
    /校验失败|大小不符/,
  )
  assert.equal(await readFile(installed.exe, 'utf8'), payload.toString())
  await rm(dir, { recursive: true, force: true })
})

test('checksum failure with no previous file is not ready', async () => {
  const dir = await tempDir()
  const payload = Buffer.from('expected')
  const manifest = manifestFor(payload)
  await assert.rejects(() => installBroker({
    manifest,
    dataDir: dir,
    platform: 'win32',
    arch: 'x64',
    download: async (_url, dest) => { await writeFile(dest, Buffer.from('nope')) },
  }), /校验失败|大小不符/)
  const state = brokerState({ dataDir: dir, manifest, platform: 'win32', arch: 'x64' })
  assert.equal(state.state, STATUS.CHECKSUM_FAILED)
  assert.equal(state.exe, null)
  await rm(dir, { recursive: true, force: true })
})

test('fillManifest binds the exe digest and leaves the template unchanged', () => {
  const template = loadManifest()
  const filled = fillManifest(template, { bytes: 3, sha256: 'a'.repeat(64), sha512: 'b'.repeat(128) })
  assert.equal(filled.status, 'ready')
  assert.equal(filled.assets['win32-x64'].bytes, 3)
  assert.equal(filled.assets['win32-x64'].sha256, 'a'.repeat(64))
  assert.equal(template.status, 'unavailable')
  assert.equal(template.assets['win32-x64'].sha256, '')
  assert.equal(assertManifestAsset(filled.assets['win32-x64']), filled.assets['win32-x64'])
})

test('a bundled exe is preferred and does not require a download', () => {
  const manifest = manifestFor(Buffer.from('x'))
  const state = brokerState({
    bundled: import.meta.filename,
    dataDir: 'unused',
    manifest,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(state.state, STATUS.READY)
  assert.equal(state.source, 'bundled')
})
