/**
 * 桌面经纪人按需安装。不在 npm install / postinstall 里下载。
 * 本地构建产物（broker/dist）优先，便于开发；发布包不含该 exe。
 * 下载只接受清单里的 HTTPS 地址，sha256 与 sha512 都通过后才替换现有文件。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BROKER_EXE_NAME = 'DSHDesktopBroker.exe'
export const BROKER_MAX_BYTES = 120 * 1024 * 1024
export const STATUS = Object.freeze({
  ABSENT: 'absent',
  INSTALLING: 'installing',
  CHECKSUM_FAILED: 'checksum-failed',
  READY: 'ready',
})

const TRUSTED_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

export const MANIFEST_RELATIVE = join('src', 'components', 'desktop', 'broker-manifest.json')

/**
 * 从某个文件往上找本包的 package.json。源码在 src/components/desktop/，
 * 打进 lib/index.mjs 之后 import.meta.url 指向 lib/，两处都能落到包根。
 * 不能用相对 import.meta.url 的 ./broker-manifest.json：打包后它会指到 lib/。
 */
export function packageRootFrom(startFile) {
  let dir = dirname(startFile)
  for (let i = 0; i < 8; i++) {
    const pkgFile = join(dir, 'package.json')
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
        if (pkg?.name === 'dsh-work-components') return dir
      } catch { /* 继续往上 */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到 dsh-work-components 包根，无法读取经纪人清单')
}

export function manifestPath(pluginRoot) {
  return join(pluginRoot, MANIFEST_RELATIVE)
}

export function loadManifest(pluginRoot = packageRootFrom(fileURLToPath(import.meta.url))) {
  return JSON.parse(readFileSync(manifestPath(pluginRoot), 'utf8'))
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function bundledBrokerExe(pluginRoot) {
  return join(pluginRoot, 'src', 'components', 'desktop', 'broker', 'dist', BROKER_EXE_NAME)
}

export function installedBrokerExe(dataDir, version, key) {
  return join(dataDir, 'desktop-broker', version, key, BROKER_EXE_NAME)
}

export function assertManifestAsset(asset) {
  if (!asset) {
    throw Object.assign(new Error('没有适用于本平台的桌面经纪人清单'), { code: STATUS.ABSENT })
  }
  let url
  try { url = new URL(asset.url || '') } catch {
    throw new Error('经纪人下载地址无效')
  }
  if (url.protocol !== 'https:') throw new Error('经纪人下载地址必须是 HTTPS')
  if (!TRUSTED_HOSTS.has(url.hostname)) throw new Error(`经纪人不接受该下载主机：${url.hostname}`)
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) throw new Error('经纪人清单缺少 sha256，拒绝下载')
  if (!/^[a-f0-9]{128}$/i.test(asset.sha512 || '')) throw new Error('经纪人清单缺少 sha512，拒绝下载')
  return asset
}

function hashFileSync(file, algorithm) {
  const hash = createHash(algorithm)
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

function statusPath(dir) {
  return join(dir, 'status.json')
}

function writeStatus(dir, state, extra = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(statusPath(dir), JSON.stringify({ state, ...extra, at: new Date().toISOString() }, null, 2) + '\n')
}

function readStatus(dir) {
  try { return JSON.parse(readFileSync(statusPath(dir), 'utf8')) } catch { return null }
}

export function brokerState({ bundled, dataDir, manifest, platform = process.platform, arch = process.arch } = {}) {
  if (bundled && existsSync(bundled)) return { state: STATUS.READY, exe: bundled, source: 'bundled' }
  const key = platformKey(platform, arch)
  const version = manifest?.version
  if (!dataDir || !version) return { state: STATUS.ABSENT, exe: null, source: null }
  const dir = join(dataDir, 'desktop-broker', version, key)
  const exe = installedBrokerExe(dataDir, version, key)
  if (existsSync(exe)) return { state: STATUS.READY, exe, source: 'installed' }
  const saved = readStatus(dir)
  if (saved?.state === STATUS.CHECKSUM_FAILED) return { state: STATUS.CHECKSUM_FAILED, exe: null, source: null }
  if (saved?.state === STATUS.INSTALLING) return { state: STATUS.INSTALLING, exe: null, source: null }
  return { state: STATUS.ABSENT, exe: null, source: null }
}

/**
 * 下载并校验。失败不替换已有 exe。已有文件先移到 previous/，替换失败再移回。
 * download(url, dest, opts) 由调用方注入（测试用假下载，运行时用 tools.download）。
 */
export async function installBroker({
  manifest,
  dataDir,
  platform = process.platform,
  arch = process.arch,
  download,
  maxBytes = BROKER_MAX_BYTES,
  signal,
} = {}) {
  const key = platformKey(platform, arch)
  const asset = assertManifestAsset(manifest?.assets?.[key])
  if (asset.bytes && asset.bytes > maxBytes) throw new Error('经纪人清单声明的大小超过上限')
  const dir = join(dataDir, 'desktop-broker', manifest.version, key)
  const exe = installedBrokerExe(dataDir, manifest.version, key)
  const previous = join(dir, 'previous', BROKER_EXE_NAME)
  const tmp = join(dir, `.download-${randomBytes(8).toString('hex')}.exe`)
  mkdirSync(dir, { recursive: true })
  writeStatus(dir, STATUS.INSTALLING)
  let movedAside = false
  try {
    await download(asset.url, tmp, { signal, maxBytes })
    if (!existsSync(tmp)) throw new Error('下载没有产生文件')
    const size = statSync(tmp).size
    if (size > maxBytes || (asset.bytes && size !== asset.bytes)) {
      throw Object.assign(new Error(`经纪人大小不符（${size}）`), { code: STATUS.CHECKSUM_FAILED })
    }
    const sha256 = hashFileSync(tmp, 'sha256')
    const sha512 = hashFileSync(tmp, 'sha512')
    if (sha256 !== asset.sha256.toLowerCase() || sha512 !== asset.sha512.toLowerCase()) {
      throw Object.assign(new Error('桌面经纪人校验失败'), { code: STATUS.CHECKSUM_FAILED })
    }
    if (existsSync(exe)) {
      mkdirSync(dirname(previous), { recursive: true })
      rmSync(previous, { force: true })
      renameSync(exe, previous)
      movedAside = true
    }
    renameSync(tmp, exe)
    writeStatus(dir, STATUS.READY, { sha256, bytes: size })
    return { exe, state: STATUS.READY, source: 'installed' }
  } catch (error) {
    rmSync(tmp, { force: true })
    if (movedAside && !existsSync(exe) && existsSync(previous)) {
      try { renameSync(previous, exe) } catch { /* keep the previous copy on disk */ }
    }
    if (error?.code === STATUS.CHECKSUM_FAILED && !existsSync(exe)) writeStatus(dir, STATUS.CHECKSUM_FAILED)
    else if (!existsSync(exe)) writeStatus(dir, STATUS.ABSENT)
    throw error
  }
}
