/**
 * Minaret（NeoForge 1.21.1 服务端 NPC 模组）的「打包下载」：
 * 设置页点按钮 → 把包内自带的模组源码复制到数据目录 → 本机 Gradle 构建 jar → 放进玩家选的 mods 目录。
 *
 * - 包目录只读：源码先复制到 <state>/minaret/src 再构建，构建产物与 .gradle 缓存都落数据目录。
 * - 源码没变且 jar 还在就不重复构建（按源码内容哈希判断）。
 * - 构建需要 JDK（Java 17+ 能启动 Gradle；Java 21 工具链缺失时 Gradle 会自动下载）和联网（Gradle 发行版、
 *   NeoForge 依赖）。下载代理沿用「通用 → 下载代理」。
 * - 安装规则与 gamebot.adapters.minecraft.mod_install 一致：目录归一到 mods、旧 minaret-*.jar 先备份再替换。
 */
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, delimiter, join, relative, resolve } from 'node:path'
import { run } from '../../tools.mjs'

const SOURCE_DIR = 'minecraft-neoforge-bridge'
/** 构建时不复制的目录（产物、缓存、测试——jar 任务不需要测试源码）。 */
const SKIP = new Set(['build', '.gradle', '.idea', 'run', 'out'])
const SKIP_PATHS = new Set([join('src', 'test')])
const META = 'minaret-build.json'
const IS_WIN = process.platform === 'win32'

const httpError = (status, message) => Object.assign(new Error(message), { status })

/** 源码目录：<GameBot 代码目录>/minecraft-neoforge-bridge。 */
export function minaretSourceDir(root) {
  return join(root, SOURCE_DIR)
}

export function minaretPaths(state) {
  const base = join(state, 'minaret')
  return { base, src: join(base, 'src'), dist: join(base, 'dist'), meta: join(base, META) }
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(base, full)
    if (dir === base && SKIP.has(entry.name) && entry.isDirectory()) continue
    if (SKIP_PATHS.has(rel)) continue
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** 源码内容哈希（路径 + 内容）。 */
export function sourceHash(sourceDir) {
  const hash = createHash('sha256')
  for (const rel of walk(sourceDir).sort()) {
    hash.update(rel.replace(/\\/g, '/')).update('\0')
    hash.update(readFileSync(join(sourceDir, rel))).update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

function readMeta(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** dist 里最新的 minaret-*.jar（不含 sources / javadoc / 备份）。 */
export function findBuiltJar(dist) {
  if (!existsSync(dist)) return null
  const jars = readdirSync(dist)
    .filter((n) => /^minaret-.*\.jar$/.test(n) && !/sources|javadoc|\.bak-/.test(n))
    .map((n) => join(dist, n))
    .filter((p) => statSync(p).isFile())
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  return jars.length ? jars.at(-1) : null
}

/** 本机 java：JAVA_HOME → PATH。返回 null 表示没有。 */
export function findJava() {
  const exe = IS_WIN ? 'java.exe' : 'java'
  const home = process.env.JAVA_HOME
  if (home && existsSync(join(home, 'bin', exe))) return join(home, 'bin', exe)
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  }
  return null
}

/** 代理 URL → Java 系统属性（Gradle 包装器与 Gradle 本体都要）。 */
export function proxyProps(proxy) {
  const text = String(proxy || '').trim()
  if (!text) return []
  let u
  try { u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`) } catch { return [] }
  const props = []
  for (const scheme of ['http', 'https']) {
    props.push([`${scheme}.proxyHost`, u.hostname], [`${scheme}.proxyPort`, u.port || (u.protocol === 'https:' ? '443' : '80')])
  }
  props.push(['http.nonProxyHosts', 'localhost|127.0.0.1'])
  return props
}

/** mods 目录归一：游戏目录 / 实例目录 → mods（与 mod_install.normalize_mods_dir 一致）。 */
export function normalizeModsDir(input) {
  const path = resolve(String(input || '').trim())
  const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
  if (basename(path).toLowerCase() === 'mods') return path
  const direct = join(path, 'mods')
  if (existsSync(direct)) return direct
  for (const nested of [join(path, 'minecraft', 'mods'), join(path, '.minecraft', 'mods')]) {
    if (existsSync(nested)) return nested
  }
  if (existsSync(join(path, 'versions')) || existsSync(join(path, 'saves')) || existsSync(join(path, 'options.txt'))) return direct
  if (isDir(join(path, 'minecraft'))) return join(path, 'minecraft', 'mods')
  if (isDir(join(path, '.minecraft'))) return join(path, '.minecraft', 'mods')
  if (['manifest.json', 'instance.cfg', 'mmc-pack.json'].some((f) => existsSync(join(path, f)))) {
    return isDir(join(path, 'minecraft')) ? join(path, 'minecraft', 'mods') : direct
  }
  return path
}

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 17)

/** 把 jar 放进 mods：旧版 minaret-*.jar 先备份（.bak-<时间>）再删除，同名先备份再覆盖。 */
export async function installJar(jar, modsInput) {
  const raw = String(modsInput || '').trim()
  if (!raw) throw httpError(400, '请先填写 mods 目录')
  const target = normalizeModsDir(raw)
  await mkdir(target, { recursive: true })
  const dest = join(target, basename(jar))
  const tag = stamp()
  const backups = []
  for (const name of await readdir(target)) {
    if (!/^minaret-.*\.jar$/.test(name) || name.includes('.bak-')) continue
    const old = join(target, name)
    if (!(await stat(old)).isFile()) continue
    const backup = `${old}.bak-${tag}`
    await copyFile(old, backup)
    backups.push(backup)
    await unlink(old)
  }
  await copyFile(jar, dest)
  return { modsDir: target, dest, backups }
}

/**
 * 构建（或复用）Minaret jar，返回 { jar, built, hash }。
 * @param {{ root: string, state: string, proxy?: string, log?: (line: string) => void, step?: (text: string) => void }} opts
 */
export async function ensureMinaretJar({ root, state, proxy, log = () => {}, step = () => {} }) {
  const override = process.env.GAMEBOT_MINARET_JAR
  if (override && existsSync(override)) return { jar: override, built: false, hash: '', source: 'env' }

  const source = minaretSourceDir(root)
  if (!existsSync(join(source, 'build.gradle'))) {
    throw httpError(409, `未找到 Minaret 模组源码：${source}（用外部「GameBot 目录」时需要含 ${SOURCE_DIR}）`)
  }
  const paths = minaretPaths(state)
  const hash = sourceHash(source)
  const cached = findBuiltJar(paths.dist)
  const meta = readMeta(paths.meta)
  if (cached && meta?.hash === hash) {
    log(`源码未变化，复用已构建的 ${basename(cached)}`)
    return { jar: cached, built: false, hash }
  }

  const java = findJava()
  if (!java) {
    throw httpError(409, '未找到 Java：构建 Minaret 需要先安装 JDK（17 或更新，推荐 21），并设置 JAVA_HOME 或加入 PATH')
  }

  step('正在复制模组源码')
  await rm(paths.src, { recursive: true, force: true })
  await mkdir(paths.src, { recursive: true })
  await cp(source, paths.src, {
    recursive: true,
    filter: (src) => {
      const rel = relative(source, src)
      if (!rel) return true
      if (SKIP_PATHS.has(rel)) return false
      return !SKIP.has(rel.split(/[\\/]/)[0])
    },
  })

  const props = proxyProps(proxy)
  if (props.length) {
    const file = join(paths.src, 'gradle.properties')
    const prior = existsSync(file) ? await readFile(file, 'utf8') : ''
    await writeFile(file, `${prior.replace(/\s*$/, '\n')}${props.map(([k, v]) => `systemProp.${k}=${v}`).join('\n')}\n`)
  }

  step('正在构建 Minaret（首次需下载 Gradle 与 NeoForge，可能要几分钟）')
  const wrapperJar = join(paths.src, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  if (!existsSync(wrapperJar)) throw httpError(409, `缺少 Gradle 包装器：${wrapperJar}`)
  const jvmArgs = props.map(([k, v]) => `-D${k}=${v}`)
  await run(java, [
    '-Dfile.encoding=UTF-8', ...jvmArgs,
    '-classpath', wrapperJar,
    'org.gradle.wrapper.GradleWrapperMain',
    'jar', '--console=plain', '--no-daemon',
  ], { cwd: paths.src, onLine: log }).catch((error) => {
    throw httpError(502, `Minaret 构建失败：${error.message}（请检查 JDK、网络与「通用 → 下载代理」）`)
  })

  const libs = join(paths.src, 'build', 'libs')
  const built = findBuiltJar(libs)
  if (!built) throw httpError(502, `构建完成但未找到 jar：${libs}`)
  await mkdir(paths.dist, { recursive: true })
  // 旧版本 jar 不留，dist 里只保留这次的。
  for (const name of await readdir(paths.dist)) if (/^minaret-.*\.jar$/.test(name)) await unlink(join(paths.dist, name))
  const jar = join(paths.dist, basename(built))
  await copyFile(built, jar)
  await writeFile(paths.meta, JSON.stringify({ hash, jar: basename(jar), builtAt: new Date().toISOString() }, null, 2))
  // 构建树只为产出 jar，用完即删（下次从源码重新复制，Gradle 的全局缓存仍在）。
  await rm(paths.src, { recursive: true, force: true }).catch(() => {})
  return { jar, built: true, hash }
}

/** 设置页「打包下载」：构建 → 安装到 mods 目录。 */
export async function buildAndInstall({ root, state, proxy, modsDir, log = () => {} }) {
  if (!String(modsDir || '').trim()) throw httpError(400, '请先填写 mods 目录')
  const { jar, built } = await ensureMinaretJar({ root, state, proxy, log })
  const installed = await installJar(jar, modsDir)
  const message = `Minaret 已${built ? '构建并' : ''}放入 ${installed.modsDir}（${basename(jar)}）。请重启 Minecraft 后再启动服务。jar 路径：${jar}`
  return { action: installed.backups.length ? 'replaced' : 'installed', jar, built, ...installed, message }
}
