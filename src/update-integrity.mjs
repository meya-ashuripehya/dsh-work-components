/**
 * npm 自更新：只接受精确版本的 HTTPS tarball，校验 sha512 integrity 后才把文件交给调用方。
 * 调用方负责在校验成功之后才执行官方安装命令。本模块不写 profile。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** 更新包上限。市场 50 MiB 限制另由打包检查负责；这里拒绝明显过大的下载。 */
export const MAX_UPDATE_BYTES = 96 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

export function registryBase(registry) {
  const raw = String(registry || '').trim() || 'https://registry.npmjs.org'
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withScheme)
  if (url.protocol !== 'https:') throw new Error('npm 仓库必须使用 HTTPS')
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url
}

export function assertTrustedTarballUrl(tarball, registry) {
  let url
  try { url = new URL(tarball) } catch {
    throw new Error('tarball 地址无效')
  }
  if (url.protocol !== 'https:') throw new Error('tarball 必须是 HTTPS')
  const reg = registryBase(registry)
  if (url.host !== reg.host && url.host !== 'registry.npmjs.org') {
    throw new Error(`tarball 主机不在信任的仓库上：${url.host}`)
  }
  return url
}

export function parseSha512Integrity(integrity) {
  const parts = String(integrity || '').split(/\s+/).filter(Boolean)
  const token = parts.find((part) => part.startsWith('sha512-'))
  if (!token) throw new Error('元数据缺少 sha512 integrity')
  const raw = Buffer.from(token.slice('sha512-'.length), 'base64')
  if (raw.length !== 64) throw new Error('sha512 integrity 长度无效')
  return raw
}

export function assertNpmVersionMeta(meta, { packageName, version }) {
  if (!meta || typeof meta !== 'object') throw new Error('版本元数据无效')
  if (meta.name !== packageName) throw new Error(`包名不符：${meta.name || '(空)'} ≠ ${packageName}`)
  if (meta.version !== version) throw new Error(`版本不符：${meta.version || '(空)'} ≠ ${version}`)
  const tarball = meta.dist?.tarball
  if (!tarball) throw new Error('元数据缺少 tarball 地址')
  assertTrustedTarballUrl(tarball, 'https://registry.npmjs.org')
  parseSha512Integrity(meta.dist?.integrity)
  const file = decodeURIComponent(new URL(tarball).pathname.split('/').pop() || '')
  if (!file.endsWith('.tgz') || !file.includes(version)) {
    throw new Error(`tarball 文件名与版本不符：${file}`)
  }
  return meta
}

async function readJson(res) {
  if (!res.ok) throw new Error(`npm 仓库返回 HTTP ${res.status}`)
  return res.json()
}

export async function resolveUpdateTarget({
  packageName,
  targetVersion,
  registry = 'https://registry.npmjs.org',
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const base = registryBase(registry)
  const headers = { accept: 'application/json', 'user-agent': 'dsh-work-components-updater' }
  const packumentUrl = `${base.origin}${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(packageName).replace(/%40/g, '@')}`
  if (targetVersion) {
    const res = await fetchImpl(`${packumentUrl}/${encodeURIComponent(targetVersion)}`, { headers, signal })
    const meta = await readJson(res)
    return assertNpmVersionMeta(meta, { packageName, version: targetVersion })
  }
  const res = await fetchImpl(packumentUrl, { headers, signal })
  const body = await readJson(res)
  const latest = body?.['dist-tags']?.latest
  if (!latest) throw new Error('npm 仓库未提供 dist-tags.latest')
  const meta = body.versions?.[latest]
  if (!meta) throw new Error(`dist-tags.latest=${latest} 但版本元数据缺失`)
  return assertNpmVersionMeta(meta, { packageName, version: latest })
}

function headerName(block) {
  return block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
}

/** 在 integrity 已核对之后读取包内 package.json，确认包名和版本没有被调包。 */
export function readPackedPackageJson(buffer) {
  const tar = gunzipSync(buffer)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = headerName(header)
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('tarball 头无效')
    offset += 512
    const data = tar.subarray(offset, offset + size)
    const base = name.split('/').filter(Boolean)
    if (base.length === 2 && base[1] === 'package.json') return JSON.parse(data.toString('utf8'))
    offset += Math.ceil(size / 512) * 512
  }
  throw new Error('tarball 缺少 package.json')
}

async function followTarball(url, { fetchImpl, registry, signal, headers, hops = 0 }) {
  if (hops > 3) throw new Error('重定向次数过多')
  assertTrustedTarballUrl(url, registry)
  const res = await fetchImpl(url, { redirect: 'manual', signal, headers })
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    try { await res.body?.cancel?.() } catch { /* already closed */ }
    if (!location) throw new Error('重定向缺少 location')
    return followTarball(new URL(location, url).toString(), { fetchImpl, registry, signal, headers, hops: hops + 1 })
  }
  return res
}

async function writeBody(res, dest, maxBytes, onProgress) {
  const declared = Number(res.headers.get('content-length')) || 0
  if (declared > maxBytes) throw new Error(`tarball 声明大小超过上限（${declared} > ${maxBytes}）`)
  const hash = createHash('sha512')
  const file = createWriteStream(dest)
  let received = 0
  try {
    const reader = res.body?.getReader?.()
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`tarball 超过大小上限（${buf.length} > ${maxBytes}）`)
      hash.update(buf)
      await new Promise((ok, fail) => file.end(buf, (error) => (error ? fail(error) : ok())))
      onProgress?.(buf.length, declared || buf.length)
      return hash.digest()
    }
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) throw new Error(`tarball 超过大小上限（${received} > ${maxBytes}）`)
      const chunk = Buffer.from(value)
      hash.update(chunk)
      if (!file.write(chunk)) await new Promise((ok) => file.once('drain', ok))
      onProgress?.(received, declared)
    }
    await new Promise((ok, fail) => file.end((error) => (error ? fail(error) : ok())))
    if (declared && received !== declared) throw new Error(`下载不完整：${received}/${declared} 字节`)
    return hash.digest()
  } catch (error) {
    file.destroy()
    throw error
  }
}

/**
 * 下载到随机临时文件，sha512 与包内版本都通过后才改名为最终文件。
 * 失败时删除临时文件，不调用 onVerified。
 */
export async function stageVerifiedNpmUpdate({
  packageName,
  targetVersion,
  registry = 'https://registry.npmjs.org',
  fetchImpl = globalThis.fetch,
  destDir,
  maxBytes = MAX_UPDATE_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  onProgress,
  meta: givenMeta,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const linked = controller.signal
  const scratch = await mkdtemp(join(destDir, '.part-'))
  const tmp = join(scratch, `${randomBytes(8).toString('hex')}.tgz`)
  try {
    const meta = givenMeta || await resolveUpdateTarget({
      packageName, targetVersion, registry, fetchImpl, signal: linked,
    })
    assertNpmVersionMeta(meta, { packageName, version: meta.version })
    if (targetVersion && meta.version !== targetVersion) {
      throw new Error(`目标版本 ${targetVersion} 与元数据 ${meta.version} 不一致`)
    }
    const expected = parseSha512Integrity(meta.dist.integrity)
    const res = await followTarball(meta.dist.tarball, {
      fetchImpl,
      registry,
      signal: linked,
      headers: { 'user-agent': 'dsh-work-components-updater', accept: 'application/octet-stream' },
    })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const digest = await writeBody(res, tmp, maxBytes, onProgress)
    if (!digest.equals(expected)) {
      throw new Error('tarball sha512 与 dist.integrity 不一致')
    }
    const { readFile } = await import('node:fs/promises')
    const packed = readPackedPackageJson(await readFile(tmp))
    if (packed.name !== packageName || packed.version !== meta.version) {
      throw new Error(`tarball 内包身份不符：${packed.name}@${packed.version}`)
    }
    const finalName = `${packageName.replace('/', '-')}-${meta.version}.tgz`
    const dest = join(destDir, finalName)
    await rename(tmp, dest)
    return { dest, meta }
  } catch (error) {
    if (linked.aborted && error?.name !== 'AbortError') {
      throw Object.assign(new Error('下载已取消'), { name: 'AbortError' })
    }
    throw error?.name === 'AbortError' ? Object.assign(new Error('下载超时或已取消'), { name: 'AbortError' }) : error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** 同一时刻只跑一个更新任务。后到的调用排队，不并行写暂存文件。 */
let updateChain = Promise.resolve()
export function withUpdateLock(fn) {
  const run = updateChain.then(fn, fn)
  updateChain = run.then(() => {}, () => {})
  return run
}
