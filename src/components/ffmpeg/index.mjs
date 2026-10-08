/**
 * 工作组件：ffmpeg
 *
 * 上游：Kinocut（原 mcp-video）— https://github.com/KyaniteLabs/kinocut
 * PyPI：kinocut（入口命令 kino；`uvx --from kinocut kino` / pip install kinocut）
 * 选型理由：功能最全的维护中 FFmpeg 向 MCP（约 200 个类型化工具：剪辑/转码/字幕/探针/质量门禁等），
 * 有 Windows 支持与 doctor；避免未维护或带已知命令注入风险的薄封装。
 *
 * 安装：设置页「下载安装」→ tools/ffmpeg（uv venv，与 Blender/Unity 同模式）。不把 FFmpeg 二进制打进仓库。
 * 本机前提：系统已安装 ffmpeg / ffprobe（PATH 或下方 ffmpegPath）。
 *
 * 拟议 SettingsSchema 键（CN）：
 * - ffmpegEnabled（启用）：默认关；打开后挂载 Kinocut MCP
 * - ffmpegPackage（pip 包名）：默认 kinocut，可带版本；改后需重新下载安装
 * - ffmpegPath（FFmpeg 可执行文件路径）：可选；留空用 PATH；填写后启动时把其目录前置到 PATH
 * - uvPath（uv 路径）：共用
 *
 * @see ../../../docs/component-module.md
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { installVenvTool, which } from '../../tools.mjs'
import { IS_WIN, managedEntry, NOT_INSTALLED, OFF, resolveUvx, stdio } from '../shared.mjs'
import { mcpNotReady, result } from '../../connect-lib.mjs'

export const id = 'ffmpeg'

/** FFmpeg 是 CLI，不是常驻 GUI；进程探测用不到，仅作展示名。 */
export const app = { name: 'FFmpeg', exe: IS_WIN ? 'ffmpeg.exe' : 'ffmpeg', match: /^ffmpeg$/ }

export const meta = {
  id: 'ffmpeg',
  title: 'FFmpeg',
  group: '工作组件',
  url: 'https://github.com/KyaniteLabs/kinocut',
  serverName: 'ffmpeg',
  summary: '本机媒体转换 / 探针 / 剪辑（Kinocut MCP，封装 FFmpeg）。需要本机已安装 ffmpeg 并在 PATH 中，或在设置里指定路径。',
}

/** 解析本机 ffmpeg：设置路径优先，否则 PATH。返回 { path, source } 或 null。 */
export function resolveFfmpeg(cfg) {
  const raw = String(cfg?.ffmpegPath || '').trim()
  if (raw) {
    if (existsSync(raw)) return { path: raw, source: 'setting' }
    const withExe = IS_WIN && !/\.exe$/i.test(raw) ? raw + '.exe' : raw
    if (existsSync(withExe)) return { path: withExe, source: 'setting' }
  }
  const p = which('ffmpeg')
  return p ? { path: p, source: 'system' } : null
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'ffmpeg',
  label: 'FFmpeg',
  url: 'https://github.com/KyaniteLabs/kinocut',
  serverName: 'ffmpeg',
  summary: '本机媒体转换 / 探针 / 剪辑（Kinocut MCP，封装 FFmpeg）。需要本机已安装 ffmpeg 并在 PATH 中，或在设置里指定路径。',
  keys: ['ffmpegEnabled', 'ffmpegPackage', 'ffmpegPath', 'uvPath'],
  spec: (cfg) => cfg.ffmpegPackage || 'kinocut',
  installed(cfg) { return !!managedEntry('ffmpeg', this.spec(cfg), 'kino') },
  install(cfg, task, hooks) {
    return installVenvTool(task, {
      id: 'ffmpeg',
      spec: this.spec(cfg),
      entry: 'kino',
      beforeReplace: hooks.beforeReplace,
    })
  },
  launch(cfg) {
    if (!cfg.ffmpegEnabled) return OFF
    const spec = this.spec(cfg)
    const env = {}
    // 有自定义路径时把其所在目录前置到 PATH；没有 FFmpeg 时仍启动 MCP（与 Blender/Godot 一致），
    // 「已连接」探测会提示未找到 ffmpeg，避免装好包却因本机 CLI 缺失而永远 status=off。
    const ff = resolveFfmpeg(cfg)
    if (ff?.source === 'setting') {
      const dir = dirname(ff.path)
      const key = IS_WIN ? 'Path' : 'PATH'
      const cur = process.env[key] || process.env.PATH || ''
      env[key] = dir + (IS_WIN ? ';' : ':') + cur
      if (IS_WIN) env.PATH = env[key]
    }
    const exe = managedEntry('ffmpeg', spec, 'kino')
    if (exe) return { ok: true, source: 'managed', config: stdio('ffmpeg', exe, [], { env }) }
    const uvx = resolveUvx(cfg)
    if (!uvx) return { ok: false, missing: true, reason: NOT_INSTALLED(spec) }
    return {
      ok: true,
      source: uvx.source,
      viaUvx: true,
      config: stdio('ffmpeg', uvx.path, ['--from', spec, 'kino'], { env }),
    }
  },
  note(cfg) {
    const ff = resolveFfmpeg(cfg)
    if (!ff) {
      return 'Kinocut 需要本机 FFmpeg。「下载安装」只装 MCP 服务器（tools\\ffmpeg）；请另装 ffmpeg/ffprobe（例如 winget install ffmpeg），或填写下方「FFmpeg 路径」。'
    }
    return `本机 FFmpeg：${ff.path}（${ff.source === 'setting' ? '设置路径' : '系统 PATH'}）。「下载安装」安装的是 Kinocut（kino）MCP，媒体编解码仍使用本机 ffmpeg。`
  },
}

export async function probe(ctx) {
  const ff = resolveFfmpeg(ctx.cfg)
  if (!ff) {
    return result(
      'no-app',
      '未找到本机 FFmpeg：请安装并加入 PATH，或在设置中填写「FFmpeg 路径」（Kinocut 依赖本机 ffmpeg/ffprobe）',
      'ffmpeg',
    )
  }
  const nr = mcpNotReady(ctx, this)
  if (nr) return nr
  return result('connected', `FFmpeg 可用（${ff.path}），Kinocut MCP 已就绪`, 'ffmpeg')
}

export default component
