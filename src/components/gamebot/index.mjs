/**
 * 游戏组件共享层：内嵌 GameBot（REST body + MCP stdio 桥）+ 每个游戏一个组件的工厂。
 * 本目录本身不注册为组件；各游戏卡片见 ../gamebot-<game>/index.mjs。
 *
 * - 一个共享 REST body：任一游戏启用时自动启动（acquireBody），全部关闭时停止（releaseBody）。
 * - 每个游戏一个 MCP 服务器（serverName gamebot-<game>），桥以 GAMEBOT_GAME=<game> 运行，
 *   只暴露该游戏的会话 / 配置（游戏参数固定，跨游戏 session 被拒绝，list_games 去掉）。
 * - 设置键：<id>Enabled（每次启动强制关闭，见 src/index.mjs EPHEMERAL_ENABLED_KEYS），
 *   共享 gamebotUrl / gamebotRoot（持久化），以及每个游戏的全部 GameBot 配置（./fields.mjs）。
 * - 随包自带、已验证：没有「下载安装」。首次启用时自动准备共享 Python 环境：用插件自管的 uv + Python 3.12
 *   在数据目录建 venv，从 PyPI 装 pyproject.toml 里的依赖（不安装 GameBot 包本身，代码经 PYTHONPATH 从包里加载，
 *   不往包目录写任何东西）；成功后写标记文件，半途失败的环境下次启用会重建。
 * - 可写状态（venv、game-configs.json、记忆、outbox）都在 <数据目录>/gamebot（见 ../../tools.mjs dataDir）。
 * - 卡片是配置的唯一来源：每次 launch（启用或改设置）都 PATCH /v1/games/<game>。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { dataDir, installUv, managedPaths, pluginRoot, PYTHON_VERSION, removeDir, run, uvEnv, venvBin } from '../../tools.mjs'
import { IS_WIN, OFF, resolveUv, stdio } from '../shared.mjs'
import { httpJson, mcpNotReady, result, tcpOpen } from '../../connect-lib.mjs'
import { acquireBody, releaseBody, stopBody } from './process.mjs'
import { gameSettingKeys, toGameBotPatch } from './fields.mjs'

export const DEFAULT_URL = 'http://127.0.0.1:8766'

/** GameBot 支持的游戏（与 src/gamebot/config_store.py 的默认配置一致；fake 仅测试用，不出卡片）。 */
export const GAMES = {
  minecraft: {
    title: 'Minecraft',
    summary: 'Minecraft：NeoForge Minaret 模组驱动（WebSocket），观察 / 动作 / 大脑 / 记忆。',
  },
  civilization: {
    title: '文明 VI',
    summary: 'Civilization VI 陪玩：经 civ6-mcp 读取局面、TRIXCompanion 模组（玩家操作后评论）。',
  },
  vision: {
    title: '视觉兜底',
    summary: '视觉桌面驱动（截图 + 键鼠）：只处理启动器、菜单、设置页，不用于主循环。',
  },
}

export function bundledRoot() {
  return join(pluginRoot(), 'src', 'components', 'gamebot')
}

const hasGameBot = (r) => !!(r && existsSync(join(r, 'src', 'gamebot', 'mcp_bridge.py')))

/** GameBot 代码目录：填了且有效的外部 gamebotRoot，否则包内自带的 src/components/gamebot。 */
export function resolveRoot(cfg) {
  const fromCfg = String(cfg?.gamebotRoot || '').trim()
  if (fromCfg && hasGameBot(fromCfg)) return fromCfg
  return bundledRoot()
}

/**
 * GameBot 的可写目录（venv、data/）。包内自带的代码 → <数据目录>/gamebot；
 * 外部 gamebotRoot → 那个目录本身（用户自己的检出，沿用它原来的 data/ 与 .venv）。
 */
export function stateDir(root) {
  return resolve(root) === resolve(bundledRoot()) ? join(dataDir(), 'gamebot') : root
}

const venvDir = (root) => join(stateDir(root), '.venv')
const venvPython = (root) => venvBin(venvDir(root), 'python')
const READY_MARKER = '.dsh-gamebot-ready.json'

/** 依赖签名：pyproject.toml 内容 + 代码目录。变了（升级 / 换 gamebotRoot）就重装依赖。 */
function wantedMarker(root) {
  let deps = ''
  try { deps = createHash('sha256').update(readFileSync(join(root, 'pyproject.toml'))).digest('hex').slice(0, 16) } catch {}
  return { v: 2, root: resolve(root), deps }
}

/** 已就绪的 venv python；没有标记 / 标记不符（半途失败、升级）时返回 null。 */
export function resolvePython(root) {
  if (!root) return null
  const py = venvPython(root)
  if (!existsSync(py)) return null
  try {
    const got = JSON.parse(readFileSync(join(venvDir(root), READY_MARKER), 'utf8'))
    const want = wantedMarker(root)
    if (got?.v === want.v && got.root === want.root && got.deps === want.deps) return py
  } catch {}
  return null
}

function bridgeReady(root) {
  return hasGameBot(root)
}

function gameUrl(cfg) {
  return String(cfg.gamebotUrl || DEFAULT_URL).trim() || DEFAULT_URL
}

/** pyproject.toml 里 [project].dependencies 与 optional vision（pip 兜底路径用；uv 路径直接读 pyproject）。 */
function pyprojectDeps(root, extras = ['vision']) {
  const text = readFileSync(join(root, 'pyproject.toml'), 'utf8')
  const list = (block) => [...String(block || '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
  // 数组以单独一行的 ] 结束（元素里可能有 uvicorn[standard] 这样的 ]）。
  const deps = list(/^dependencies\s*=\s*\[([\s\S]*?)^\]/m.exec(text)?.[1])
  for (const x of extras) deps.push(...list(new RegExp(`^${x}\\s*=\\s*\\[([\\s\\S]*?)^\\]`, 'm').exec(text)?.[1]))
  return deps
}

/** Host interpreters for the pip fallback (GameBot needs Python >=3.10,<3.13). */
function systemPythonCandidates() {
  const out = []
  const push = (p) => { if (p && existsSync(p) && !out.includes(p)) out.push(p) }
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA
    for (const ver of ['Python312', 'Python311', 'Python310']) {
      if (local) push(join(local, 'Programs', 'Python', ver, 'python.exe'))
      push(join('C:\\', ver, 'python.exe'))
    }
    for (const base of [process.env.CONDA_PREFIX, join(process.env.USERPROFILE || '', 'anaconda3'), join(process.env.USERPROFILE || '', 'miniconda3')].filter(Boolean)) {
      push(join(base, 'python.exe'))
    }
    out.push('python')
  } else {
    out.push('python3.12', 'python3.11', 'python3.10', 'python3')
  }
  return out
}

function runPy(py, args, { cwd, log } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(py, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    let out = ''
    child.stdout?.on('data', (b) => { out += String(b); log?.(String(b).trimEnd()) })
    child.stderr?.on('data', (b) => log?.(String(b).trimEnd()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`python ${args.join(' ')} 退出码 ${code}`))))
  })
}

async function pickSystemPython(log) {
  const check = 'import sys; raise SystemExit(0 if (3,10)<=sys.version_info[:2]<(3,13) else 1)'
  for (const cand of systemPythonCandidates()) {
    try { await runPy(cand, ['-c', check]); log?.(`使用系统 Python：${cand}`); return cand } catch {}
  }
  return null
}

/**
 * 共享 Python 环境（首次启用时自动执行，不是用户可见的「下载安装」）：
 *  1. uv：插件自管 tools/uv → 设置里的 uvPath → 系统 uv；都没有就下载插件自管的 uv（GitHub Release）。
 *  2. uv venv --python 3.12（插件自管的 Python，必要时由 uv 下载到 tools/python）。
 *  3. uv pip install -r pyproject.toml --extra vision：从 PyPI 装依赖（GameBot 代码本身走 PYTHONPATH，不安装）。
 *  uv 整条路径失败时退回系统 Python 3.10–3.12 + pip。成功后写 READY_MARKER。
 */
export async function installShared(cfg, task) {
  const root = resolveRoot(cfg)
  task.step('正在校验 GameBot 文件')
  if (!bridgeReady(root)) throw new Error(`未找到 GameBot MCP 桥：${join(root, 'src', 'gamebot', 'mcp_bridge.py')}`)
  if (!existsSync(join(root, 'pyproject.toml'))) throw new Error(`缺少 pyproject.toml：${root}`)
  const state = stateDir(root)
  const venv = venvDir(root)
  const py = venvPython(root)
  const proxy = String(cfg.proxy || '').trim() || undefined
  await mkdir(state, { recursive: true })
  // 没有就绪标记 = 新建或上次半途失败：整个重建。
  task.step('正在准备 GameBot 运行环境')
  await removeDir(venv)
  let via = ''
  try {
    let uv = resolveUv(cfg)?.path
    if (!uv) {
      task.step('正在下载依赖：uv')
      await installUv({ ...task, proxy })
      uv = managedPaths().uv
    }
    const env = uvEnv(proxy)
    task.step(`正在创建 Python ${PYTHON_VERSION} 环境`)
    await run(uv, ['venv', '--python', PYTHON_VERSION, '--no-project', venv], { cwd: state, env, onLine: task.log })
    task.step('正在下载依赖：GameBot Python 包')
    await run(uv, ['pip', 'install', '--python', py, '-r', join(root, 'pyproject.toml'), '--extra', 'vision'], { cwd: state, env, onLine: task.log })
    via = `uv + Python ${PYTHON_VERSION}`
  } catch (error) {
    task.log(`uv 环境准备失败，改用系统 Python：${error?.message ?? error}`)
    await removeDir(venv)
    const sysPy = await pickSystemPython(task.log)
    if (!sysPy) throw new Error(`uv 环境准备失败（${error?.message ?? error}），且未找到系统 Python 3.10–3.12`)
    await runPy(sysPy, ['-m', 'venv', venv], { cwd: state, log: task.log })
    await runPy(py, ['-m', 'pip', 'install', '-q', ...pyprojectDeps(root)], { cwd: state, log: task.log })
    via = `系统 Python ${sysPy}`
  }
  task.step('正在校验依赖')
  await runPy(py, ['-c', 'import httpx, fastapi, uvicorn, websockets, pydantic'], { cwd: state, log: task.log })
  await writeFile(join(venv, READY_MARKER), JSON.stringify({ ...wantedMarker(root), via, installedAt: new Date().toISOString() }, null, 2))
  task.log(`安装完成：GameBot Python 环境（${via}）`)
  return py
}

let provisioning = null
/** 自动准备 .venv（多个游戏同时启用时只跑一次）。返回 python 路径。 */
async function ensurePython(cfg, root, id) {
  const ready = resolvePython(root)
  if (ready) return ready
  const log = (l) => { if (l) console.info(`[dsh-workbench:${id}] ${l}`) }
  provisioning ??= installShared(cfg, { step: log, log, proxy: String(cfg.proxy || '').trim() || undefined }).finally(() => { provisioning = null })
  await provisioning
  return resolvePython(root)
}

async function pushConfig(url, game, cfg) {
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/games/${game}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toGameBotPatch(game, cfg)),
  })
  if (!res.ok) throw new Error(`下发 ${game} 设置失败：HTTP ${res.status}`)
}

/** 为一个游戏生成组件模块（id / app / meta / component / probe）。 */
export function createGameModule(game) {
  const info = GAMES[game]
  if (!info) throw new Error(`unknown game ${game}`)
  const id = `gamebot-${game}`
  const enabledKey = `${id}Enabled`
  const serverName = id

  const app = { name: `GameBot · ${info.title}`, exe: 'python / uvicorn', match: /$^/ }
  const meta = { id, title: info.title, group: '游戏', url: '', serverName, summary: info.summary }

  /** @type {import('../shared.mjs').ComponentModule} */
  const component = {
    id,
    label: info.title,
    url: '',
    serverName,
    summary: info.summary,
    keys: [enabledKey, 'gamebotUrl', 'gamebotRoot', ...gameSettingKeys(game)],
    builtin: true,
    /** 随包自带：代码在就算已安装（Python 环境在首次启用时自动准备，见 installShared）。 */
    installed(cfg) { return bridgeReady(resolveRoot(cfg)) },
    async launch(cfg) {
      if (cfg[enabledKey] !== true) {
        await releaseBody(id)
        return OFF
      }
      const root = resolveRoot(cfg)
      if (!bridgeReady(root)) { await releaseBody(id); return { ok: false, missing: true, reason: '未找到 gamebot.mcp_bridge：请检查内置目录或「GameBot 目录」设置' } }
      let py
      try { py = await ensurePython(cfg, root, id) } catch (error) {
        await releaseBody(id)
        return { ok: false, reason: `GameBot Python 环境安装失败：${error?.message ?? error}` }
      }
      if (!py) { await releaseBody(id); return { ok: false, reason: 'GameBot Python 环境安装失败' } }
      const url = gameUrl(cfg)
      try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0 } catch {
        await releaseBody(id)
        return { ok: false, reason: `GameBot URL 无效：${url}` }
      }
      try {
        await acquireBody(id, { root, state: stateDir(root), python: py, url, log: (l) => { if (l) console.info(`[dsh-workbench:${id}] ${l}`) } })
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) }
      }
      try { await pushConfig(url, game, cfg) } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) }
      }
      const env = {
        GAMEBOT_URL: url.replace(/\/$/, ''),
        GAMEBOT_GAME: game,
        PYTHONPATH: [join(root, 'src'), process.env.PYTHONPATH].filter(Boolean).join(IS_WIN ? ';' : ':'),
        PYTHONIOENCODING: 'utf-8',
        // 字节码缓存写数据目录，不在包里生成 __pycache__。
        PYTHONPYCACHEPREFIX: join(stateDir(root), 'pycache'),
      }
      return {
        ok: true,
        source: 'managed',
        runtime: `GameBot（共享 body）→ ${url}，仅 ${info.title}`,
        config: stdio(serverName, py, ['-m', 'gamebot.mcp_bridge'], { env, cwd: stateDir(root) }),
      }
    },
    async beforeRemove(log) {
      log?.(`正在释放 GameBot body（${id}）`)
      await releaseBody(id)
    },
    note(cfg) {
      return [
        `打开「启用」会自动启动共享 GameBot REST body（${gameUrl(cfg)}），并挂载只含 ${info.title} 的 MCP（工具前缀 mcp__${serverName}__）。`,
        '所有游戏共用一个 body：任一游戏启用即启动，全部关闭才停止。每次应用/会话启动默认关闭；REST 地址与目录会记住。',
        '【双脑警告】不要同时让 DSH 桌面大脑与 GameBot 大脑对同一游戏发动作。',
      ].join(' ')
    },
  }

  async function probe(ctx) {
    const url = gameUrl(ctx.cfg)
    let u
    try { u = new URL(url) } catch { return result('unreachable', `GameBot URL 无效：${url}`, 'socket') }
    const host = (u.hostname || '127.0.0.1').replace(/^\[|\]$/g, '')
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    if (!(await tcpOpen(host === 'localhost' ? '127.0.0.1' : host, port))) {
      return result('no-app', `无法连接 GameBot REST ${u.host}：打开「启用」后将自动启动`, 'socket')
    }
    const health = await httpJson(`${url.replace(/\/$/, '')}/health`)
    if (!health || health.ok !== true) return result('unreachable', `端口已开放，但 /health 异常（${u.host}）`, 'http')
    const nr = mcpNotReady(ctx, this)
    if (nr) return result('unreachable', `GameBot REST 正常，但 ${info.title} MCP 桥未挂载：请检查「启用」开关`, 'mcp')
    return result('connected', `GameBot REST + ${info.title} MCP 已就绪（${u.host}）`, 'http+mcp')
  }

  return { id, app, meta, component, probe }
}

export { stopBody }
