import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateWithVideo } from '../chatroom/video.mjs'
import { SA_INLINE_MAX_BYTES } from './credential.mjs'
import { assessRemoteVideoSize, SA_NO_BUCKET_ERROR } from './download-guard.mjs'
import {
  appendCleanupEntry,
  assertDeletableObjectName,
  deleteObject,
  deleteTaskObjects,
  readCleanupList,
  resetCleanupSweepClock,
} from './bucket.mjs'

const BUCKET = 'test-bucket'
const PREFIX = 'dsh-video'

function storageFetch(hooks = {}) {
  const uploads = []
  const deletes = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const method = init.method || 'GET'
    if (hooks.before) hooks.before({ url: u, method, init })
    if (u.includes('upload/storage/v1') && method === 'POST') {
      uploads.push({ url: u, len: init.body?.length })
      return { ok: true, json: async () => ({ name: decodeURIComponent(u.split('name=')[1] || ''), bucket: BUCKET }) }
    }
    if (u.includes('/storage/v1/b/') && method === 'DELETE') {
      const name = decodeURIComponent(u.split('/o/')[1] || '')
      deletes.push(name)
      if (hooks.deleteFail?.has(name)) return { ok: false, status: 503, json: async () => ({ error: { message: 'fail' } }) }
      return { ok: true, status: 204, json: async () => ({}) }
    }
    if (u.includes(':generateContent')) {
      const body = JSON.parse(init.body || '{}')
      const part = body.contents?.[0]?.parts?.[0]
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), _part: part }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'unexpected' } }) }
  }
  return { fetchImpl, uploads, deletes }
}

test('no bucket + metadata 50 MB → reject before download (assess)', () => {
  const info = { duration: 60, formats: [{ filesize: 50 * 1024 * 1024 }] }
  const r = assessRemoteVideoSize(info)
  assert.equal(r.ok, false)
  assert.equal(r.reason, SA_NO_BUCKET_ERROR)
})

test('no bucket + 10 min duration only → estimated reject', () => {
  const r = assessRemoteVideoSize({ duration: 600, formats: [] })
  assert.equal(r.ok, false)
  assert.equal(r.source, 'duration')
})

test('with bucket + large file → upload once, fileData gs uri, delete after', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 2)
  const { fetchImpl, uploads, deletes } = storageFetch()
  let gens = 0
  const wrapped = async (url, init) => {
    const res = await fetchImpl(url, init)
    if (String(url).includes(':generateContent')) gens++
    return res
  }
  const r = await generateWithVideo({
    fetchImpl: wrapped,
    credentialSource: 'serviceAccount',
    vertexProject: 'p',
    vertexLocation: 'us-central1',
    getAccessToken: async () => 'tok',
    videoBucket: BUCKET,
    videoBucketPrefix: PREFIX,
    meta: { name: 'big.mp4', mediaType: 'video/mp4' },
    load: async () => big,
    saveRemote: async () => {},
    prompt: 'test',
  })
  assert.equal(r.ok, true)
  assert.equal(uploads.length, 1)
  assert.ok(uploads[0].url.includes(BUCKET))
  assert.equal(deletes.length, 1)
  assert.ok(deletes[0].startsWith(`${PREFIX}/`))
})

test('retry twice → single upload, delete once at end', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 3)
  const { fetchImpl, uploads, deletes } = storageFetch()
  let n = 0
  const wrapped = async (url, init) => {
    if (String(url).includes(':generateContent')) {
      n++
      if (n === 1) return { ok: false, status: 500, json: async () => ({ error: { message: 'temp' } }) }
    }
    return fetchImpl(url, init)
  }
  const r = await generateWithVideo({
    fetchImpl: wrapped,
    credentialSource: 'serviceAccount',
    vertexProject: 'p',
    vertexLocation: 'us-central1',
    getAccessToken: async () => 'tok',
    videoBucket: BUCKET,
    videoBucketPrefix: PREFIX,
    meta: { name: 'big.mp4', mediaType: 'video/mp4' },
    load: async () => big,
    saveRemote: async () => {},
    prompt: 'test',
  })
  // 第一次 500 触发退避重试，第二次成功：上传仍只有一次，删除仍只有一次。
  assert.equal(r.ok, true)
  assert.equal(uploads.length, 1)
  assert.equal(deletes.length, 1)
})

test('delete failure → result ok, cleanup list records object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bkt-'))
  resetCleanupSweepClock()
  try {
    const big = Buffer.alloc(21 * 1024 * 1024, 4)
    const failName = new Set()
    const { fetchImpl, uploads } = storageFetch({
      before: ({ url, method }) => {
        if (method === 'POST' && url.includes('upload')) {
          const name = decodeURIComponent(url.split('name=')[1] || '')
          failName.add(name)
        }
      },
      deleteFail: failName,
    })
    const r = await generateWithVideo({
      fetchImpl,
      credentialSource: 'serviceAccount',
      vertexProject: 'p',
      vertexLocation: 'us-central1',
      getAccessToken: async () => 'tok',
      videoBucket: BUCKET,
      videoBucketPrefix: PREFIX,
      dataRoot: dir,
      meta: { name: 'big.mp4', mediaType: 'video/mp4' },
      load: async () => big,
      saveRemote: async () => {},
      prompt: 'test',
    })
    assert.equal(r.ok, true)
    assert.equal(uploads.length, 1)
    const list = readCleanupList(dir)
    assert.equal(list.objects.length, 1)
    assert.equal(list.objects[0].bucket, BUCKET)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prefix guard: delete outside task prefix is refused (no HTTP)', async () => {
  const { fetchImpl, deletes } = storageFetch()
  const bad = await deleteObject({ fetchImpl, token: 't', bucket: BUCKET, name: `${PREFIX}/other-task/x.mp4`, prefix: PREFIX, taskId: 'task-a' })
  assert.equal(bad.skipped, true)
  assert.equal(deletes.length, 0)
  const ok = await deleteObject({ fetchImpl, token: 't', bucket: BUCKET, name: `${PREFIX}/task-a/x.mp4`, prefix: PREFIX, taskId: 'task-a' })
  assert.equal(ok.ok, true)
  assert.equal(deletes.length, 1)
})

test('apiKey mode: no bucket upload or delete', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 5)
  const { fetchImpl, uploads, deletes } = storageFetch()
  let fileUploads = 0
  const wrapped = async (url, init) => {
    if (String(url).includes('/upload/v1beta/files')) {
      fileUploads++
      return { ok: true, headers: { get: (h) => (h === 'x-goog-upload-url' ? 'https://up.example/u1' : null) }, json: async () => ({}) }
    }
    if (String(url).startsWith('https://up.example/')) {
      return { ok: true, json: async () => ({ file: { uri: 'https://gen.example/f1', name: 'files/f1', mimeType: 'video/mp4', state: 'ACTIVE', expirationTime: new Date(Date.now() + 86400000).toISOString() } }) }
    }
    return fetchImpl(url, init)
  }
  const r = await generateWithVideo({
    fetchImpl: wrapped,
    apiKey: 'key',
    credentialSource: 'apiKey',
    meta: { name: 'big.mp4', mediaType: 'video/mp4' },
    load: async () => big,
    saveRemote: async () => {},
    prompt: 'test',
  })
  assert.equal(r.ok, true)
  assert.equal(uploads.length, 0)
  assert.equal(deletes.length, 0)
  assert.equal(fileUploads, 1)
})

test('generateWithVideo uses fileData.fileUri gs:// with mimeType', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 6)
  let part = null
  const { fetchImpl } = storageFetch({
    before: ({ url, init }) => {
      if (String(url).includes(':generateContent')) part = JSON.parse(init.body).contents[0].parts[0]
    },
  })
  await generateWithVideo({
    fetchImpl,
    credentialSource: 'serviceAccount',
    vertexProject: 'p',
    vertexLocation: 'us-central1',
    getAccessToken: async () => 'tok',
    videoBucket: BUCKET,
    videoBucketPrefix: PREFIX,
    meta: { name: 'clip.mp4', mediaType: 'video/mp4' },
    load: async () => big,
    saveRemote: async () => {},
    prompt: 'x',
  })
  assert.match(part.fileData.fileUri, /^gs:\/\//)
  assert.equal(part.fileData.mimeType, 'video/mp4')
})
