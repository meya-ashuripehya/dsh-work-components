/**
 * 游戏组件共享层：内嵌 GameBot（REST body + MCP stdio 桥）+ 每个游戏一个组件的工厂。
 * 本目录本身不注册为组件；各游戏卡片见 ../gamebot-<game>/index.mjs。
 *
 * - 一个共享 REST body：任一游戏启用时自动启动（acquireBody），全部关闭时停止（releaseBody）。
 * - 每个游戏一个 MCP 服务器（serverName gamebot-<game>），桥以 GAMEBOT_GAME=<game> 运行，
 *   只暴露该游戏的会话 / 配置（游戏参数固定，跨游戏 session 被拒绝，list_games 去掉）。
 * - 设置键：<id>Enabled（每次启动强制关闭，见 src/index.mjs EPHEMERAL_ENABLED_KEYS），
 *   共享 gamebotUrl / gamebotRoot（持久化），以及每个游戏的全部 GameBot 配置（./fields.mjs）。
 * - 仓库自带、已验证：没有「下载安装」。首次启用时自动创建 / 复用共享 .venv（pip install -e .）。
 * - 卡片是配置的唯一来源：每次 launch（启用或改设置）都 PATCH /v1/games/<game>。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pluginRoot } from '../../tools.mjs'
import { IS_WIN, OFF, stdio } from '../shared.mjs'
import { httpJson, mcpNotReady, result, tcpOpen } from '../../connect-lib.mjs'
import { acquireBody, releaseBody, stopBody } from './process.mjs'
import { gameSettingKeys, toGameBotPatch } from './fields.mjs'

export const DEFAULT_URL = 'http://127.0.0.1:8766'

/** GameBot 支持的游戏（与 src/gamebot/config_store.py 的默认配置一致；fake 仅测试用，不出卡片）。 */
export const GAMES = {
  minecraft: {
    title: 'Minecraft',
    summary: 'Minecraft：NeoForge Minaret 同进程 / Paper Mineflayer 驱动，观察 / 动作 / 大脑 / 记忆。',
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

export function resolveRoot(cfg) {
  const has = (r) => r && (existsSync(join(r, 'src', 'gamebot', 'mcp_bridge.py')) || existsSync(join(r, 'src', 'gamebot')))
  const fromCfg = String(cfg.gamebotRoot || '').trim()
  if (has(fromCfg)) return fromCfg
  const bundled = bundledRoot()
  if (has(bundled)) return bundled
  return fromCfg || bundled
}

export function resolvePython(root) {
  if (!root) return null
  const candidates = IS_WIN
    ? [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'Scripts', 'python')]
    : [join(root, '.venv', 'bin', 'python'), join(root, '.venv', 'bin', 'python3')]
  return candidates.find((p) => existsSync(p)) || null
}

function bridgeReady(root) {
  return !!(root && existsSync(join(root, 'src', 'gamebot', 'mcp_bridge.py')))
}

function gameUrl(cfg) {
  return String(cfg.gamebotUrl || DEFAULT_URL).trim() || DEFAULT_URL
}

/** Host interpreters usable to create .venv (GameBot needs Python >=3.10,<3.13). */
function systemPythonCandidates() {
  const out = []
  const push = (p) => { if (p && existsSync(p) && !out.includes(p)) out.push(p) }
  if (IS_WIN) {
    push(join(pluginRoot(), '..', 'TRIX-GAMEBOT', '.venv', 'Scripts', 'python.exe'))
    const local = process.env.LOCALAPPDATA
    for (const ver of ['Python312', 'Python311', 'Python310']) {
      if (local) push(join(local, 'Programs', 'Python', ver, 'python.exe'))
      push(join('C:\\', ver, 'python.exe'))
    }
    for (const base of [process.env.CONDA_PREFIX, 'S:\\Anaconda', join(process.env.USERPROFILE || '', 'anaconda3'), join(process.env.USERPROFILE || '', 'miniconda3')].filter(Boolean)) {
      push(join(base, 'python.exe'))
      push(join(base, 'envs', 'YUKI', 'python.exe'))
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
    try { await runPy(cand, ['-c', check]); log?.(`选用系统 Python：${cand}`); return cand } catch {}
  }
  return null
}

/** 共享 Python 环境：组件目录 .venv + pip install -e .（首次启用时自动执行，不是用户可见的下载）。 */
export async function installShared(cfg, task) {
  const root = resolveRoot(cfg)
  task.step('检查 GameBot 目录')
  if (!bridgeReady(root)) throw new Error(`找不到 GameBot MCP 桥：${join(root, 'src', 'gamebot', 'mcp_bridge.py')}`)
  if (!existsSync(join(root, 'pyproject.toml'))) throw new Error(`缺少 pyproject.toml：${root}`)
  let py = resolvePython(root)
  if (!py) {
    task.step('创建 .venv（需要 Python 3.10–3.12）')
    const sysPy = await pickSystemPython(task.log)
    if (!sysPy) throw new Error('找不到 Python 3.10–3.12：请安装后再点「下载安装」')
    await runPy(sysPy, ['-m', 'venv', '.venv'], { cwd: root, log: task.log })
    py = resolvePython(root)
    if (!py) throw new Error(`创建 .venv 后仍找不到 python：${root}`)
  }
  task.log(`使用 Python：${py}`)
  task.step('pip install -e .（GameBot + 桥依赖）')
  await runPy(py, ['-m', 'pip', 'install', '-e', '.', '-q'], { cwd: root, log: task.log })
  await runPy(py, ['-c', 'import httpx, fastapi'], { cwd: root, log: task.log })
  task.log('GameBot 内嵌包就绪（所有游戏共用）')
}

let provisioning = null
/** 自动准备 .venv（多个游戏同时启用时只跑一次）。返回 python 路径。 */
async function ensurePython(cfg, root, id) {
  const ready = resolvePython(root)
  if (ready) return ready
  const log = (l) => { if (l) console.info(`[dsh-workbench:${id}] ${l}`) }
  provisioning ??= installShared(cfg, { step: log, log }).finally(() => { provisioning = null })
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
    /** 仓库自带：代码在就算已安装（Python 环境在首次启用时自动准备）。 */
    installed(cfg) { return bridgeReady(resolveRoot(cfg)) },
    async launch(cfg) {
      if (cfg[enabledKey] !== true) {
        await releaseBody(id)
        return OFF
      }
      const root = resolveRoot(cfg)
      if (!bridgeReady(root)) { await releaseBody(id); return { ok: false, missing: true, reason: '找不到 gamebot.mcp_bridge：确认内嵌目录或填写 GameBot 目录' } }
      let py
      try { py = await ensurePython(cfg, root, id) } catch (error) {
        await releaseBody(id)
        return { ok: false, reason: `自动准备 GameBot Python 环境失败：${error?.message ?? error}` }
      }
      if (!py) { await releaseBody(id); return { ok: false, reason: `自动准备 GameBot Python 环境失败（${root}）` } }
      const url = gameUrl(cfg)
      try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0 } catch {
        await releaseBody(id)
        return { ok: false, reason: `GameBot URL 无效：${url}` }
      }
      try {
        await acquireBody(id, { root, python: py, url, log: (l) => { if (l) console.info(`[dsh-workbench:${id}] ${l}`) } })
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
      }
      return {
        ok: true,
        source: 'managed',
        runtime: `GameBot（共享 body）→ ${url}，仅 ${info.title}`,
        config: stdio(serverName, py, ['-m', 'gamebot.mcp_bridge'], { env, cwd: root }),
      }
    },
    async beforeRemove(log) {
      log?.(`释放 GameBot body（${id}）…`)
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
      return result('no-app', `连不上 GameBot REST ${u.host}：打开「启用」会自动启动 body`, 'socket')
    }
    const health = await httpJson(`${url.replace(/\/$/, '')}/health`)
    if (!health || health.ok !== true) return result('unreachable', `端口开着但 /health 异常（${u.host}）`, 'http')
    const nr = mcpNotReady(ctx, this)
    if (nr) return result('unreachable', `GameBot REST 正常，但 ${info.title} MCP 桥未挂上：检查启用开关`, 'mcp')
    return result('connected', `GameBot REST + ${info.title} MCP 已就绪（${u.host}）`, 'http+mcp')
  }

  return { id, app, meta, component, probe }
}

export { stopBody }
