import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  assertNpmVersionMeta,
  readPackedPackageJson,
  resolveUpdateTarget,
  stageVerifiedNpmUpdate,
  withUpdateLock,
} from './update-integrity.mjs'

const NAME = 'dsh-work-components'

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0)
  header.write(name)
  header.write('0000777\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(' ', 148, 156)
  header[156] = 48
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return header
}

function packTarball(pkg) {
  const body = Buffer.from(JSON.stringify(pkg))
  const header = tarHeader('package/package.json', body.length)
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]))
}

function integrityOf(bytes) {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64')
}

function metaFor(version, bytes, pkg = { name: NAME, version }) {
  const packed = bytes || packTarball(pkg)
  return {
    packed,
    meta: {
      name: NAME,
      version,
      dist: {
        tarball: `https://registry.npmjs.org/${NAME}/-/${NAME}-${version}.tgz`,
        integrity: integrityOf(packed),
      },
    },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-update-'))
}

test('resolveUpdateTarget uses one packument and the latest version object', async () => {
  const { meta } = metaFor('1.2.3')
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    assert.match(url, /dsh-work-components$/)
    return jsonResponse({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': meta } })
  }
  const got = await resolveUpdateTarget({ packageName: NAME, fetchImpl })
  assert.equal(got.version, '1.2.3')
  assert.equal(calls, 1)
})

test('targetVersion is not replaced by a later latest tag', async () => {
  const { meta } = metaFor('1.0.0')
  const fetchImpl = async (url) => {
    assert.match(url, /1\.0\.0$/)
    return jsonResponse(meta)
  }
  const got = await resolveUpdateTarget({ packageName: NAME, targetVersion: '1.0.0', fetchImpl })
  assert.equal(got.version, '1.0.0')
})

test('metadata version drift is rejected before download', async () => {
  let downloads = 0
  const fetchImpl = async (url) => {
    if (url.endsWith('.tgz')) downloads++
    return jsonResponse({ name: NAME, version: '1.0.1', dist: { tarball: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64') } })
  }
  await assert.rejects(
    () => resolveUpdateTarget({ packageName: NAME, targetVersion: '1.0.0', fetchImpl }),
    /版本不符/,
  )
  assert.equal(downloads, 0)
})

test('missing integrity and http tarball fail before a file is kept', async () => {
  assert.throws(() => assertNpmVersionMeta({
    name: NAME,
    version: '1.0.0',
    dist: { tarball: `https://registry.npmjs.org/${NAME}/-/${NAME}-1.0.0.tgz` },
  }, { packageName: NAME, version: '1.0.0' }), /integrity/)
  assert.throws(() => assertNpmVersionMeta({
    name: NAME,
    version: '1.0.0',
    dist: {
      tarball: `http://registry.npmjs.org/${NAME}/-/${NAME}-1.0.0.tgz`,
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
    },
  }, { packageName: NAME, version: '1.0.0' }), /HTTPS/)
})

test('matching tarball is staged and a tampered body never replaces the previous file', async () => {
  const dir = await tempDir()
  const previous = join(dir, 'previous.txt')
  await writeFile(previous, 'old-version')
  const good = metaFor('1.2.3', null, { name: NAME, version: '1.2.3' })
  const fetchImpl = async (url) => {
    assert.equal(url, good.meta.dist.tarball)
    return new Response(good.packed, { status: 200, headers: { 'content-length': String(good.packed.length) } })
  }
  const staged = await stageVerifiedNpmUpdate({
    packageName: NAME,
    targetVersion: '1.2.3',
    destDir: dir,
    fetchImpl,
    meta: good.meta,
  })
  const saved = JSON.parse((await readFile(staged.dest)).length ? '{}' : '{}')
  void saved
  const packed = readPackedPackageJson(await readFile(staged.dest))
  assert.equal(packed.version, '1.2.3')
  assert.equal(await readFile(previous, 'utf8'), 'old-version')

  const bad = Buffer.from(good.packed)
  bad[bad.length - 1] ^= 0xff
  const fetchBad = async () => new Response(bad, { status: 200 })
  await assert.rejects(
    () => stageVerifiedNpmUpdate({
      packageName: NAME,
      targetVersion: '1.2.3',
      destDir: dir,
      fetchImpl: fetchBad,
      meta: good.meta,
    }),
    /sha512/,
  )
  assert.equal(await readFile(previous, 'utf8'), 'old-version')
  await rm(dir, { recursive: true, force: true })
})

test('inner package identity mismatch is rejected after the hash matches', async () => {
  const dir = await tempDir()
  const packed = packTarball({ name: NAME, version: '9.9.9' })
  const meta = {
    name: NAME,
    version: '1.2.3',
    dist: {
      tarball: `https://registry.npmjs.org/${NAME}/-/${NAME}-1.2.3.tgz`,
      integrity: integrityOf(packed),
    },
  }
  await assert.rejects(
    () => stageVerifiedNpmUpdate({
      packageName: NAME,
      targetVersion: '1.2.3',
      destDir: dir,
      fetchImpl: async () => new Response(packed),
      meta,
    }),
    /包身份不符/,
  )
  await rm(dir, { recursive: true, force: true })
})

test('redirects off the registry are refused', async () => {
  const dir = await tempDir()
  const good = metaFor('1.2.3')
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { location: 'https://evil.example/stolen.tgz' },
  })
  await assert.rejects(
    () => stageVerifiedNpmUpdate({
      packageName: NAME,
      destDir: dir,
      fetchImpl,
      meta: good.meta,
    }),
    /信任的仓库/,
  )
  await rm(dir, { recursive: true, force: true })
})

test('declared size above the cap fails and leaves no tarball', async () => {
  const dir = await tempDir()
  const good = metaFor('1.2.3')
  const fetchImpl = async () => new Response(good.packed, { status: 200, headers: { 'content-length': '999999999' } })
  await assert.rejects(
    () => stageVerifiedNpmUpdate({
      packageName: NAME,
      destDir: dir,
      fetchImpl,
      meta: good.meta,
      maxBytes: 1024,
    }),
    /超过上限/,
  )
  const names = await import('node:fs/promises').then((fs) => fs.readdir(dir))
  assert.equal(names.some((name) => name.endsWith('.tgz')), false)
  await rm(dir, { recursive: true, force: true })
})

test('an aborted download fails and leaves no staged tarball', async () => {
  const dir = await tempDir()
  const good = metaFor('1.2.3')
  const fetchImpl = async () => { throw Object.assign(new Error('socket hang up'), { name: 'AbortError' }) }
  await assert.rejects(
    () => stageVerifiedNpmUpdate({
      packageName: NAME,
      destDir: dir,
      fetchImpl,
      meta: good.meta,
    }),
    /取消|超时|hang up/,
  )
  const names = await import('node:fs/promises').then((fs) => fs.readdir(dir))
  assert.equal(names.some((name) => name.endsWith('.tgz')), false)
  await rm(dir, { recursive: true, force: true })
})

test('update lock does not run two tasks at once', async () => {
  let active = 0
  let max = 0
  const task = () => withUpdateLock(async () => {
    active++
    max = Math.max(max, active)
    await new Promise((resolve) => setTimeout(resolve, 30))
    active--
  })
  await Promise.all([task(), task(), task()])
  assert.equal(max, 1)
})

test('wrong package name is rejected', () => {
  const { meta } = metaFor('1.2.3')
  assert.throws(() => assertNpmVersionMeta({ ...meta, name: 'other' }, { packageName: NAME, version: '1.2.3' }), /包名不符/)
})

void randomBytes
void stat
