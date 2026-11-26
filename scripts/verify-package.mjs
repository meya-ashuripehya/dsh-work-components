/**
 * 发布检查，三部分分开报告：
 *   --source     工作区清单与生命周期（不把 node_modules 或本地 lib 当成发布物已完整）
 *   --tgz <file> 真实 npm pack 结果
 *   --host       真实宿主。没有证据文件时记为未运行，不算通过认证
 *
 * 例：node scripts/verify-package.mjs --source --tgz path.tgz --require-size
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digestFile } from './stage-broker-asset.mjs'

const root = resolve(import.meta.dirname, '..')
export const MARKET_TGZ_LIMIT = 52_428_800
export const MARKET_TGZ_BUDGET = MARKET_TGZ_LIMIT - 5 * 1024 * 1024

const REQUIRED = [
  'package/package.json',
  'package/lib/index.mjs',
  'package/lib/local-loader-worker.mjs',
  'package/lib/component-sdk.mjs',
  'package/lib/channel-telegram.mjs',
  'package/lib/channel-qq.mjs',
  'package/lib/gmail-server.mjs',
  'package/lib/client.js',
  'package/cordis.patch.yml',
  'package/icon.svg',
  'package/locale/en.json',
  'package/locale/zh.json',
  'package/LICENSE',
  'package/NOTICE',
  'package/src/components/desktop/broker-manifest.json',
  'package/src/components/desktop/broker-install.mjs',
  'package/SECURITY.md',
  'package/PRIVACY.md',
  'package/CHANGELOG.md',
  'package/docs/compatibility.md',
  'package/docs/release/market-readiness.md',
]
const FORBIDDEN = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(?:pem|key|p12|pfx)$/i,
  /\.bak(?:-|$)/i,
  /__pycache__\//,
  /DSHDesktopBroker\.exe$/,
  /scripts\/prepare\.mjs$/,
  /(?:^|\/)\.eclipse\//,
]

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

function sha512(file) {
  return new Promise((ok, fail) => {
    const hash = createHash('sha512')
    createReadStream(file).on('error', fail).on('data', (chunk) => hash.update(chunk)).on('end', () => ok(hash.digest('hex')))
  })
}

function git(args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : ''
}

function sourceReport() {
  const problems = []
  const notes = []
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!existsSync(join(root, 'lib', 'client.js'))) problems.push('handwritten lib/client.js is missing')
  else notes.push('lib/client.js present (handwritten; not evidence that the published tarball is complete)')
  if (pkg.scripts?.prepare !== 'node scripts/prepare.mjs') problems.push('repo prepare script changed')
  if (!existsSync(join(root, 'scripts', 'prepare.mjs'))) problems.push('scripts/prepare.mjs missing from the repo')
  const files = pkg.files || []
  if (files.some((item) => item === 'src/components/desktop/**')) problems.push('files still uses the broad desktop glob')
  if (!files.includes('src/components/desktop/broker-manifest.json')) problems.push('files missing broker-manifest.json')
  if (files.some((item) => item.startsWith('scripts/'))) problems.push('files ships scripts/; prepare would have to be executable')
  const repoManifest = JSON.parse(readFileSync(join(root, 'src', 'components', 'desktop', 'broker-manifest.json'), 'utf8'))
  const repoAsset = repoManifest.assets?.['win32-x64']
  if (repoManifest.status !== 'unavailable' || repoAsset?.sha256 || repoAsset?.sha512) {
    problems.push('repo broker-manifest.json must stay an unhashed template')
  }
  for (const rel of ['lib/index.mjs', 'lib/component-sdk.mjs', 'lib/channel-telegram.mjs', 'lib/gmail-server.mjs', 'lib/channel-qq.mjs', 'lib/local-loader-worker.mjs']) {
    notes.push(`${rel}: ${existsSync(join(root, rel)) ? 'present locally (generated or tracked; not a pack proof)' : 'not built in this tree'}`)
  }
  const head = git(['rev-parse', 'HEAD']) || 'unknown'
  const dirty = git(['status', '--porcelain'])
  return {
    scope: 'source',
    status: problems.length ? 'fail' : 'pass',
    head,
    version: pkg.version,
    dirty: dirty ? dirty.split(/\r?\n/).filter(Boolean).length : 0,
    problems,
    notes,
  }
}

function listTarball(file) {
  const run = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(run.stderr || 'tar failed')
  return run.stdout.split(/\r?\n/).map((line) => line.replace(/\\/g, '/')).filter(Boolean)
}

function readPackedJson(file) {
  const run = spawnSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error('tarball has no package/package.json')
  return JSON.parse(run.stdout)
}

const BUNDLE_RELATIVE_MANIFEST = 'new URL("./broker-manifest.json"'

function assertManifestBinding(manifest, brokerAsset, problems) {
  const asset = manifest?.assets?.['win32-x64']
  if (!asset) {
    problems.push('packed manifest has no win32-x64 asset')
    return
  }
  if (!brokerAsset) {
    if (manifest.status !== 'unavailable' || asset.sha256 || asset.sha512) {
      problems.push('packed manifest is not the unhashed template; pass --broker-asset to verify a filled manifest')
    }
    return
  }
  if (!existsSync(brokerAsset)) {
    problems.push(`broker asset missing: ${brokerAsset}`)
    return
  }
  return digestFile(brokerAsset).then((digest) => {
    if (manifest.status !== 'ready') problems.push('filled manifest status is not ready')
    if (asset.bytes !== digest.bytes) problems.push(`manifest bytes ${asset.bytes} != exe ${digest.bytes}`)
    if (String(asset.sha256).toLowerCase() !== digest.sha256) problems.push('manifest sha256 does not match the exe')
    if (String(asset.sha512).toLowerCase() !== digest.sha512) problems.push('manifest sha512 does not match the exe')
  })
}

async function assertPackagedManifest(tarball, brokerAsset, problems) {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-verify-tgz-'))
  try {
    const extracted = spawnSync('tar', ['-xzf', tarball, '-C', dest], { encoding: 'utf8' })
    if (extracted.status !== 0) {
      problems.push(extracted.stderr || 'could not extract tarball')
      return
    }
    const pkgDir = join(dest, 'package')
    const bundle = readFileSync(join(pkgDir, 'lib', 'index.mjs'), 'utf8')
    if (bundle.includes(BUNDLE_RELATIVE_MANIFEST)) {
      problems.push('lib/index.mjs still resolves broker-manifest.json beside the bundle')
    }
    const probeFile = join(dest, 'probe.mjs')
    const moduleUrl = pathToFileURL(join(pkgDir, 'src', 'components', 'desktop', 'broker-install.mjs')).href
    writeFileSync(probeFile, [
      `import { loadManifest, manifestPath } from ${JSON.stringify(moduleUrl)};`,
      `const root = ${JSON.stringify(pkgDir)};`,
      'const manifest = loadManifest(root);',
      'const path = manifestPath(root).replaceAll("\\\\", "/");',
      'if (!path.endsWith("src/components/desktop/broker-manifest.json")) throw new Error("manifest path is not under the package root: " + path);',
      'if (!manifest || typeof manifest.version !== "string" || !manifest.assets?.["win32-x64"]?.url) throw new Error("manifest is not structurally valid");',
      'console.log(JSON.stringify({ version: manifest.version, url: manifest.assets["win32-x64"].url }));',
      '',
    ].join('\n'))
    const probe = spawnSync(process.execPath, [probeFile], { encoding: 'utf8' })
    if (probe.status !== 0) problems.push(`packaged loadManifest failed: ${(probe.stderr || probe.stdout || '').trim()}`)
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'src', 'components', 'desktop', 'broker-manifest.json'), 'utf8'))
    const binding = assertManifestBinding(manifest, brokerAsset, problems)
    if (binding) await binding
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

async function tgzReport(file, requireSize, brokerAsset) {
  const problems = []
  const abs = resolve(file)
  if (!existsSync(abs)) return { scope: 'tgz', status: 'fail', problems: [`missing ${file}`] }
  const info = statSync(abs)
  const names = listTarball(abs)
  for (const need of REQUIRED) if (!names.includes(need)) problems.push(`missing ${need}`)
  for (const name of names) {
    if (FORBIDDEN.some((pattern) => pattern.test(name))) problems.push(`forbidden member ${name}`)
  }
  let packed
  try { packed = readPackedJson(abs) } catch (error) { problems.push(error.message) }
  if (packed?.scripts?.prepare) problems.push('published package.json still has prepare')
  if (packed?.scripts && Object.values(packed.scripts).some((command) => String(command).includes('scripts/'))) {
    problems.push('published scripts reference scripts/ which is not shipped')
  }
  if (requireSize && info.size > MARKET_TGZ_BUDGET) {
    problems.push(`tarball ${info.size} bytes exceeds budget ${MARKET_TGZ_BUDGET} (market limit ${MARKET_TGZ_LIMIT})`)
  }
  if (names.includes('package/lib/index.mjs') && names.includes('package/src/components/desktop/broker-install.mjs')) {
    await assertPackagedManifest(abs, brokerAsset, problems)
  }
  return {
    scope: 'tgz',
    status: problems.length ? 'fail' : 'pass',
    file: abs,
    bytes: info.size,
    members: names.length,
    sha512: await sha512(abs),
    version: packed?.version || null,
    budget: MARKET_TGZ_BUDGET,
    marketLimit: MARKET_TGZ_LIMIT,
    problems,
  }
}

function hostReport(evidence) {
  if (!evidence) {
    return {
      scope: 'host',
      status: 'not-run',
      certified: false,
      reason: 'no isolated host evidence file was provided',
    }
  }
  if (!existsSync(evidence)) {
    return { scope: 'host', status: 'not-run', certified: false, reason: `evidence file missing: ${evidence}` }
  }
  const body = JSON.parse(readFileSync(evidence, 'utf8'))
  return { scope: 'host', status: body.status || 'not-run', certified: body.certified === true, evidence, body }
}

const wantSource = process.argv.includes('--source') || process.argv.slice(2).every((arg) => arg.startsWith('--') && arg !== '--tgz' && arg !== '--host')
const tgz = argValue('--tgz')
const host = process.argv.includes('--host')
const requireSize = process.argv.includes('--require-size')
const evidence = argValue('--host-evidence')
const brokerAsset = argValue('--broker-asset') ? resolve(argValue('--broker-asset')) : null

const report = { source: null, tgz: null, host: null }
if (process.argv.includes('--source') || (!tgz && !host)) report.source = sourceReport()
if (tgz) report.tgz = await tgzReport(tgz, requireSize, brokerAsset)
if (host || evidence) report.host = hostReport(evidence)

const failed = [report.source, report.tgz, report.host].some((part) => part?.status === 'fail')
console.log(JSON.stringify(report, null, 2))
if (failed) process.exit(1)
void wantSource
