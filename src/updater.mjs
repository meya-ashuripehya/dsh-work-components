/**
 * 插件自更新：检测与应用。
 *
 * 安装类型：
 *  - git：profile 以 link:/file: 指向本仓库检出 → git fetch + 与 origin/main 比较；
 *    应用：拒绝脏工作区；git pull --ff-only →（锁文件变更则 npm install）→ npm run build。
 *  - npm：已发布包 → 查 registry dist-tags.latest；应用：下载 tarball（字节进度）后经官方
 *    `dsh plugin --profile <name> add <tarball>` 写入 profile（绝不手改 profile package.json）。
 *
 * 两种应用完成后均需重启 DeepSeek Harness 才能让已加载的服务端代码生效；client.js 重开设置页即可。
 * 状态落在 dataDir()/update-state.json（上次检查日、忽略版本、进行中的任务）。
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { dataDir, PACKAGE_ID, pluginRoot, dshHome } from './tools.mjs'

const execFileAsync = promisify(execFile)
const STATE_FILE = 'update-state.json'
const STAGING_DIR = 'update-staging'
const REMOTE_REF = 'origin/main'
const PACKAGE_NAME = PACKAGE_ID
const DWELL_OK = true // exported for tests via helpers

export function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function compareSemver(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = String(b || '0').replace(/^v/i, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    const sx = String(x)
    const sy = String(y)
    if (sx !== sy) return sx < sy ? -1 : 1
  }
  return 0
}

/** 每次 DSH/插件启动都应检查；不再按本地日期去重。保留函数供测试与兼容调用。 */
export function shouldAutoCheck(_state, _today = localDateKey()) {
  return true
}

export function shouldPromptUpdate(info, state) {
  if (!info || !info.updateAvailable) return false
  const ver = info.latestVersion || info.targetVersion
  if (!ver) return false
  if (state && state.ignoredVersion && state.ignoredVersion === ver) return false
  return true
}

function statePath() {
  return join(dataDir(), STATE_FILE)
}

export function loadUpdateState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    return {
      lastCheckDate: typeof raw.lastCheckDate === 'string' ? raw.lastCheckDate : null,
      ignoredVersion: typeof raw.ignoredVersion === 'string' ? raw.ignoredVersion : null,
      job: raw.job && typeof raw.job === 'object' ? raw.job : null,
    }
  } catch {
    return { lastCheckDate: null, ignoredVersion: null, job: null }
  }
}

export function saveUpdateState(next) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const cur = loadUpdateState()
  const merged = {
    lastCheckDate: next.lastCheckDate !== undefined ? next.lastCheckDate : cur.lastCheckDate,
    ignoredVersion: next.ignoredVersion !== undefined ? next.ignoredVersion : cur.ignoredVersion,
    job: next.job !== undefined ? next.job : cur.job,
  }
  writeFileSync(statePath(), JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

export function readPackageVersion(root = pluginRoot()) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

function safeReal(p) {
  try { return realpathSync(p) } catch { try { return resolve(p) } catch { return p } }
}

/** 找出 profile 中以 link:/file: 或已安装包指向本插件根目录的条目。 */
export function findProfileBinding(root = pluginRoot()) {
  const profilesDir = join(dshHome(), 'profiles')
  if (!existsSync(profilesDir)) return null
  const want = safeReal(root)
  let names = []
  try { names = readdirSync(profilesDir) } catch { return null }
  for (const name of names) {
    const profileDir = join(profilesDir, name)
    let st
    try { st = statSync(profileDir) } catch { continue }
    if (!st.isDirectory()) continue
    const pkgFile = join(profileDir, 'package.json')
    if (!existsSync(pkgFile)) continue
    let dep = null
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      dep = pkg.dependencies?.[PACKAGE_NAME] || pkg.devDependencies?.[PACKAGE_NAME] || null
    } catch { /* ignore */ }
    const nm = join(profileDir, 'node_modules', PACKAGE_NAME)
    let pointsHere = false
    if (existsSync(nm)) {
      try { pointsHere = safeReal(nm) === want } catch { pointsHere = false }
    }
    const isLinkSpec = typeof dep === 'string' && /^(link:|file:)/i.test(dep)
    if (pointsHere || isLinkSpec) {
      return {
        profile: name,
        profileDir,
        dependency: dep,
        linked: isLinkSpec || pointsHere,
      }
    }
  }
  return null
}

export function detectInstallKind(root = pluginRoot()) {
  const binding = findProfileBinding(root)
  const hasGit = existsSync(join(root, '.git'))
  if (hasGit && (binding?.linked || !binding)) {
    // 有 .git：优先视为 git 检出（含未挂进 profile 的开发目录）。
    // 若 profile 明确是 registry 版本且 node_modules 不是 link，则仍算 npm。
    if (binding && !binding.linked && binding.dependency && !/^(link:|file:)/i.test(binding.dependency)) {
      return { kind: 'npm', binding, root, currentVersion: readPackageVersion(root) }
    }
    return { kind: 'git', binding, root, currentVersion: readPackageVersion(root) }
  }
  return { kind: 'npm', binding, root, currentVersion: readPackageVersion(root) }
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'C' }
}

async function git(root, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: root,
    env: gitEnv(),
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: opts.timeout ?? 120_000,
  })
  return { stdout: String(stdout || ''), stderr: String(stderr || '') }
}

export async function gitIsDirty(root) {
  const { stdout } = await git(root, ['status', '--porcelain'])
  return stdout.trim().length > 0
}

export async function gitCompareToOriginMain(root, { fetch = true } = {}) {
  let fetchError = null
  if (fetch) {
    try {
      await git(root, ['fetch', '--quiet', 'origin', 'main'], { timeout: 180_000 })
    } catch (error) {
      fetchError = formalGitError(error)
    }
  }
  let head = ''
  let remote = ''
  let subject = ''
  try {
    head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
    remote = (await git(root, ['rev-parse', REMOTE_REF])).stdout.trim()
    subject = (await git(root, ['log', '-1', '--format=%s', REMOTE_REF])).stdout.trim()
  } catch (error) {
    throw new Error(fetchError || formalGitError(error) || '无法读取 git 引用。')
  }
  let ahead = 0
  let behind = 0
  try {
    const counts = (await git(root, ['rev-list', '--left-right', '--count', `HEAD...${REMOTE_REF}`])).stdout.trim()
    const m = counts.match(/^(\d+)\s+(\d+)$/)
    if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
  } catch { /* ignore */ }
  return {
    head: head.slice(0, 12),
    remote: remote.slice(0, 12),
    ahead,
    behind,
    latestSubject: subject,
    fetchError,
    updateAvailable: behind > 0,
  }
}

function formalGitError(error) {
  const msg = String(error?.stderr || error?.message || error || '')
  if (/403|Authentication failed|could not read Username/i.test(msg)) {
    return '无法访问远程仓库（认证失败或权限不足）。请检查本机 git 凭据后重试。'
  }
  if (/unable to access|Could not resolve host|timed out|Failed to connect/i.test(msg)) {
    return '无法连接远程仓库。请检查网络或代理后重试。'
  }
  if (/not a git repository/i.test(msg)) return '当前安装目录不是 git 仓库。'
  const line = msg.trim().split('\n').filter(Boolean).pop() || msg
  return line.slice(0, 200)
}

export async function queryNpmLatest(registry, opts = {}) {
  const base = String(registry || '').trim().replace(/\/$/, '') || 'https://registry.npmjs.org'
  const url = `${base}/${encodeURIComponent(PACKAGE_NAME).replace(/%40/g, '@')}`
  const headers = { accept: 'application/json', 'user-agent': 'dsh-work-components-updater' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 30_000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`npm 仓库返回 HTTP ${res.status}`)
    const body = await res.json()
    const latest = body?.['dist-tags']?.latest
    if (!latest) throw new Error('npm 仓库未提供 dist-tags.latest')
    const meta = body.versions?.[latest] || {}
    const tarball = meta.dist?.tarball || null
    const shasum = meta.dist?.shasum || null
    return { latest, tarball, shasum, registry: base }
  } finally {
    clearTimeout(timer)
  }
}

export async function checkForUpdate({ force = false, cfg = {}, now = new Date() } = {}) {
  const state = loadUpdateState()
  const today = localDateKey(now)
  const install = detectInstallKind()
  const currentVersion = install.currentVersion || readPackageVersion()

  if (!force && !shouldAutoCheck(state, today)) {
    return {
      ok: true,
      skipped: true,
      reason: 'already-checked-today',
      currentVersion,
      installKind: install.kind,
      lastCheckDate: state.lastCheckDate,
      ignoredVersion: state.ignoredVersion,
    }
  }

  let result
  try {
    if (install.kind === 'git') {
      const cmp = await gitCompareToOriginMain(install.root, { fetch: true })
      const dirty = await gitIsDirty(install.root).catch(() => false)
      result = {
        ok: true,
        skipped: false,
        installKind: 'git',
        currentVersion,
        latestVersion: cmp.updateAvailable ? `${currentVersion}+${cmp.behind}` : currentVersion,
        targetVersion: cmp.remote,
        updateAvailable: cmp.updateAvailable,
        ahead: cmp.ahead,
        behind: cmp.behind,
        latestSubject: cmp.latestSubject,
        head: cmp.head,
        remote: cmp.remote,
        dirty,
        fetchError: cmp.fetchError || null,
        profile: install.binding?.profile || null,
        message: cmp.fetchError
          ? cmp.fetchError
          : cmp.updateAvailable
            ? `发现 ${cmp.behind} 个新提交（${REMOTE_REF}：${cmp.latestSubject || cmp.remote}）`
            : '已是最新版本',
      }
      // 展示用版本号：git 场景用提交说明，客户端按钮区显示 latestVersion 文本
      if (cmp.updateAvailable) {
        result.latestVersion = cmp.remote
        result.displayVersion = cmp.latestSubject ? `${cmp.remote}（${cmp.latestSubject}）` : cmp.remote
      } else {
        result.displayVersion = currentVersion
      }
    } else {
      const reg = cfg.npmRegistry || process.env.npm_config_registry || ''
      const npm = await queryNpmLatest(reg)
      const cmp = compareSemver(currentVersion, npm.latest)
      result = {
        ok: true,
        skipped: false,
        installKind: 'npm',
        currentVersion,
        latestVersion: npm.latest,
        displayVersion: npm.latest,
        targetVersion: npm.latest,
        updateAvailable: cmp < 0,
        tarball: npm.tarball,
        registry: npm.registry,
        profile: install.binding?.profile || null,
        message: cmp < 0
          ? `发现新版本 ${npm.latest}（当前 ${currentVersion || '未知'}）`
          : '已是最新版本',
      }
    }
  } catch (error) {
    saveUpdateState({ lastCheckDate: today })
    return {
      ok: false,
      skipped: false,
      error: String(error?.message || error),
      currentVersion,
      installKind: install.kind,
      lastCheckDate: today,
      ignoredVersion: state.ignoredVersion,
    }
  }

  saveUpdateState({ lastCheckDate: today })
  const ignored = result.updateAvailable && state.ignoredVersion
    && (state.ignoredVersion === result.latestVersion || state.ignoredVersion === result.targetVersion)
  return {
    ...result,
    lastCheckDate: today,
    ignoredVersion: state.ignoredVersion,
    ignored: !!ignored,
    prompt: shouldPromptUpdate(result, state),
  }
}

export function ignoreVersion(version) {
  const v = String(version || '').trim()
  if (!v) throw Object.assign(new Error('缺少要忽略的版本号'), { status: 400 })
  const state = saveUpdateState({ ignoredVersion: v })
  return { ok: true, ignoredVersion: state.ignoredVersion }
}

function setJob(patch) {
  const state = loadUpdateState()
  const job = { ...(state.job || {}), ...patch, updatedAt: Date.now() }
  saveUpdateState({ job })
  return job
}

export function getUpdateJob() {
  return loadUpdateState().job
}

function findDshCmd() {
  const candidates = []
  if (process.execPath) {
    const base = dirname(process.execPath)
    candidates.push(join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    candidates.push(join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh'))
  }
  const la = process.env.LOCALAPPDATA || ''
  if (la) {
    candidates.push(join(la, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
  }
  const home = dshHome()
  // 偶发便携布局
  candidates.push(join(home, 'runtime', 'cli', 'bin', 'dsh.cmd'))
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

async function downloadToFile(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'user-agent': 'dsh-work-components-updater' } })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = dest + '.part'
  const file = createWriteStream(tmp)
  const reader = res.body?.getReader?.()
  let done = 0
  if (reader) {
    while (true) {
      const { value, done: end } = await reader.read()
      if (end) break
      done += value.byteLength
      file.write(Buffer.from(value))
      if (onProgress) onProgress(done, total)
    }
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())))
  } else {
    const buf = Buffer.from(await res.arrayBuffer())
    done = buf.length
    writeFileSync(tmp, buf)
    if (onProgress) onProgress(done, total || done)
  }
  renameSync(tmp, dest)
  return { bytes: done, total: total || done }
}

async function runNpmInRoot(root, args, onLine) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args], {
      cwd: root,
      env: { ...process.env, npm_config_progress: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Fallback: system npm via shell if local npm-cli missing
    // Actually spawn above may fail if no local npm — handle below
    let failed = false
    child.on('error', () => { failed = true })
    // If immediate fail, we re-run with `npm` from PATH in caller
    const take = (buf) => {
      String(buf).split(/\r?\n/).forEach((line) => {
        const t = line.trim()
        if (t && onLine) onLine(t)
      })
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('close', (code) => {
      if (failed) return reject(Object.assign(new Error('spawn npm failed'), { code: 'SPAWN' }))
      if (code === 0) resolve()
      else reject(new Error(`npm ${args.join(' ')} 退出码 ${code}`))
    })
  }).catch(async (err) => {
    if (err?.code !== 'SPAWN' && !/ENOENT|spawn npm failed/i.test(String(err.message))) throw err
    await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: root,
      env: process.env,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    })
  })
}

async function applyGitUpdate(install, report) {
  const root = install.root
  if (await gitIsDirty(root)) {
    throw Object.assign(
      new Error('工作区有未提交的更改，已拒绝自动更新。请先提交、贮藏或清理后再试。'),
      { status: 409, code: 'DIRTY' },
    )
  }
  report({ state: 'running', step: '正在拉取 origin/main…', progress: 10, mode: 'determinate' })
  await git(root, ['pull', '--ff-only', 'origin', 'main'], { timeout: 300_000 })
  report({ step: '正在检查依赖…', progress: 45 })
  // 锁文件是否相对拉取前变化：简化为若存在 package-lock 则 npm install（幂等）
  if (existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'package.json'))) {
    report({ step: '正在安装依赖（npm install）…', progress: 55 })
    try {
      await runNpmInRoot(root, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], (line) => {
        report({ step: `正在安装依赖… ${line.slice(0, 80)}`, progress: 60 })
      })
    } catch (error) {
      // 忽略 scripts 失败时再试普通 install
      await runNpmInRoot(root, ['install', '--no-audit', '--no-fund'], () => {})
    }
  }
  report({ step: '正在构建…', progress: 80 })
  await runNpmInRoot(root, ['run', 'build'], (line) => {
    report({ step: `正在构建… ${line.slice(0, 80)}`, progress: 88 })
  })
  report({
    state: 'done',
    step: '更新完成',
    progress: 100,
    message: '更新完成，重启 DeepSeek Harness 后生效',
    restartRequired: true,
  })
}

async function applyNpmUpdate(install, targetVersion, report) {
  const profile = install.binding?.profile
  if (!profile) {
    throw Object.assign(
      new Error('未找到挂载本插件的 DeepSeek Harness 配置档，无法通过官方 dsh 命令安装。'),
      { status: 409 },
    )
  }
  const dsh = findDshCmd()
  if (!dsh) {
    throw Object.assign(
      new Error('未找到官方 dsh.cmd（DeepSeek Harness 运行时）。请确认已安装 DeepSeek Harness。'),
      { status: 500 },
    )
  }
  const reg = ''
  const npm = await queryNpmLatest(reg)
  const version = targetVersion || npm.latest
  if (!npm.tarball && !version) throw new Error('无法解析 npm 包下载地址。')
  const staging = join(dataDir(), STAGING_DIR)
  mkdirSync(staging, { recursive: true })
  const tarballUrl = (await queryNpmLatest(reg)).tarball
  // Re-query for exact version meta
  const base = 'https://registry.npmjs.org'
  const metaRes = await fetch(`${base}/${PACKAGE_NAME}/${encodeURIComponent(version)}`)
  if (!metaRes.ok) throw new Error(`无法获取 ${PACKAGE_NAME}@${version} 元数据（HTTP ${metaRes.status}）`)
  const meta = await metaRes.json()
  const url = meta?.dist?.tarball
  if (!url) throw new Error('元数据缺少 tarball 地址。')
  const dest = join(staging, `${PACKAGE_NAME}-${version}.tgz`)
  report({ state: 'running', step: `正在下载 ${PACKAGE_NAME}@${version}…`, progress: 5, mode: 'determinate' })
  await downloadToFile(url, dest, (done, total) => {
    const pct = total > 0 ? Math.min(85, Math.round((done / total) * 80) + 5) : 40
    const mb = (n) => (n / 1048576).toFixed(1)
    report({
      step: total > 0
        ? `正在下载：${mb(done)} / ${mb(total)} MiB`
        : `正在下载：${mb(done)} MiB`,
      progress: pct,
    })
  })
  report({ step: '正在通过官方 dsh 写入配置档…', progress: 88 })
  // Official path: dsh plugin --profile <name> add <tarball>
  await new Promise((resolve, reject) => {
    const args = [dsh, 'plugin', '--profile', profile, 'add', dest]
    // On Windows dsh.cmd needs shell or cmd /c
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : dsh,
      process.platform === 'win32' ? ['/c', dsh, 'plugin', '--profile', profile, 'add', dest] : ['plugin', '--profile', profile, 'add', dest],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let err = ''
    child.stdout?.on('data', (b) => report({ step: `正在安装：${String(b).trim().slice(0, 80)}` }))
    child.stderr?.on('data', (b) => { err += String(b); report({ step: `正在安装：${String(b).trim().slice(0, 80)}` }) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`dsh plugin add 失败（退出码 ${code}）${err ? '：' + err.trim().slice(0, 180) : ''}`))
    })
  })
  report({
    state: 'done',
    step: '更新完成',
    progress: 100,
    message: '更新完成，重启 DeepSeek Harness 后生效',
    restartRequired: true,
  })
}

let _applyChain = Promise.resolve()

export function startApplyUpdate({ targetVersion } = {}) {
  const existing = getUpdateJob()
  if (existing && (existing.state === 'running' || existing.state === 'queued')) {
    return { ok: true, job: existing, already: true }
  }
  const job0 = setJob({
    id: `upd-${Date.now()}`,
    state: 'queued',
    step: '排队中…',
    progress: 0,
    mode: 'indeterminate',
    message: null,
    error: null,
    restartRequired: false,
    startedAt: Date.now(),
    finishedAt: null,
  })
  _applyChain = _applyChain.then(async () => {
    const report = (patch) => setJob({ ...patch, state: patch.state || 'running' })
    try {
      report({ state: 'running', step: '开始更新…', progress: 1 })
      const install = detectInstallKind()
      if (install.kind === 'git') await applyGitUpdate(install, report)
      else await applyNpmUpdate(install, targetVersion, report)
      const job = getUpdateJob()
      setJob({ ...job, finishedAt: Date.now() })
    } catch (error) {
      setJob({
        state: 'error',
        step: '更新失败',
        progress: 0,
        mode: 'none',
        error: String(error?.message || error),
        message: String(error?.message || error),
        finishedAt: Date.now(),
      })
    }
  })
  return { ok: true, job: job0, already: false }
}

export const __test = {
  localDateKey,
  compareSemver,
  shouldAutoCheck,
  shouldPromptUpdate,
  DWELL_OK,
}
