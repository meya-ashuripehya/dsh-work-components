import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAccessToken,
  resetAccessTokenCache,
  saveServiceAccountJson,
  parseServiceAccountText,
  SA_SIZE_ERROR,
  VIDEO_SA_REL,
} from './credential.mjs'
import { videoKeyStatus, resolveVideoKey } from './key.mjs'
import { handleVideoApi, VIDEO_KEYS } from './index.mjs'
import { generateWithVideo } from '../chatroom/video.mjs'

function sampleSa(extra = {}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return {
    type: 'service_account',
    project_id: 'proj-video-test',
    client_email: 'video-sa@proj-video-test.iam.gserviceaccount.com',
    private_key: pem,
    ...extra,
  }
}

test('default credential source remains apiKey; VIDEO_KEYS includes new settings', () => {
  assert.ok(VIDEO_KEYS.includes('videoCredentialSource'))
  assert.ok(VIDEO_KEYS.includes('videoServiceAccountFile'))
  assert.ok(VIDEO_KEYS.includes('videoVertexLocation'))
  assert.equal(resolveVideoKey({ videoGeminiKey: 'k' }).credentialSource, 'apiKey')
  // 指向一个空的临时数据目录，避免依赖本机真实的服务账号文件（否则本机装了 SA 后这条会假失败）。
  const prevDir = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = join(tmpdir(), `dsh-vsa-empty-${process.pid}`)
  try {
    assert.equal(resolveVideoKey({ videoCredentialSource: 'serviceAccount' }).problem?.includes('服务账号'), true)
  } finally {
    if (prevDir === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = prevDir
  }
})

test('invalid service account JSON is rejected and not written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vsa-'))
  try {
    const bad = await saveServiceAccountJson('{"type":"user"}', dir)
    assert.equal(bad.ok, false)
    await assert.rejects(access(join(dir, VIDEO_SA_REL), constants.F_OK))
    let sent
    const sendJson = (_r, status, body) => { sent = { status, body } }
    await handleVideoApi(
      { method: 'POST', headers: {} },
      {},
      '/video/credential',
      {
        sendJson,
        readBody: async () => JSON.stringify({ json: '{"type":"user"}' }),
        getConfig: () => ({}),
        applyPatch: async () => {},
        dataRoot: dir,
      },
    )
    assert.equal(sent.status, 400)
    assert.match(sent.body.error, /service_account/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('valid service account upload writes relative path; status shows serviceAccount', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vsa-'))
  try {
    const obj = sampleSa()
    const saved = saveServiceAccountJson(JSON.stringify(obj), dir)
    assert.equal(saved.ok, true)
    assert.equal(saved.file, VIDEO_SA_REL)
    const onDisk = await readFile(join(dir, VIDEO_SA_REL), 'utf8')
    assert.ok(onDisk.includes('proj-video-test'))
    assert.match(onDisk, /BEGIN PRIVATE KEY/)
    const cfg = { videoCredentialSource: 'serviceAccount', videoServiceAccountFile: saved.file }
    const st = videoKeyStatus(cfg, { root: dir })
    assert.equal(st.ready, true)
    assert.equal(st.credentialSource, 'serviceAccount')
    assert.equal(st.projectId, 'proj-video-test')
    assert.equal(st.clientEmail, obj.client_email)
    assert.equal(resolveVideoKey(cfg, dir).credentialSource, 'serviceAccount')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('getAccessToken caches: two calls exchange token only once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vsa-'))
  resetAccessTokenCache()
  try {
    const obj = sampleSa()
    saveServiceAccountJson(JSON.stringify(obj), dir)
    const abs = join(dir, VIDEO_SA_REL)
    let calls = 0
    const fetchImpl = async (url, init) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        calls++
        return { ok: true, json: async () => ({ access_token: 'tok-' + calls, expires_in: 3600 }) }
      }
      throw new Error('unexpected ' + url)
    }
    const now = () => 1_700_000_000_000
    const a = await getAccessToken({ keyPath: abs, fetchImpl, now })
    const b = await getAccessToken({ keyPath: abs, fetchImpl, now })
    assert.equal(a.token, b.token)
    assert.equal(calls, 1)
  } finally {
    resetAccessTokenCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('service account mode rejects videos larger than 20 MB inline limit', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 1)
  const r = await generateWithVideo({
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) }),
    credentialSource: 'serviceAccount',
    vertexProject: 'p',
    vertexLocation: 'us-central1',
    getAccessToken: async () => 'fake-token',
    meta: { name: 'big.mp4', mediaType: 'video/mp4' },
    load: async () => big,
    saveRemote: async () => {},
    prompt: 'test',
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, SA_SIZE_ERROR)
})
