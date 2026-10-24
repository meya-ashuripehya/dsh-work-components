/**
 * Cursor 交接：cursor_handoff 工具定义、任务书、headless cursor-agent 运行、桌面端 deeplink。
 *
 * 运行（仅在所有者回复「执行」后）：
 *   spawn(<cursor-agent.cmd>, ['-p','--force','--trust','--output-format','stream-json', (--resume <id>)], { shell: true, cwd: 目标仓库 })
 *   任务书经 stdin 写入（避开 Windows 8 KB 命令行上限），UTF-8；stdout 按行解析 JSON：
 *     system/init → session_id；thinking delta/completed → 思考过程（面板执行明细）；tool_call started/completed → 简短进度；assistant → 文本；result → 最终结果。
 *   完成 = 收到 result 事件（subtype success）且进程退出。超时 → taskkill /T /F 结束整个进程树。
 *   stderr 只留尾部（PowerShell 会话里那条 S:\Anaconda requests 警告无害，过滤掉不报）。
 *   结束后在 cwd 跑 git diff --stat，连同最终文本、退出码、session_id 回报房间。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isJsonValue } from '../../vendor/dsh-tools/util-values.js'

/**
 * 解析 cursor-agent 命令：设置里填了就用它（绝对路径必须存在）；留空时依次查 PATH 和常见安装位置。
 * 不含任何个人路径。返回 { path, source: 'setting' | 'PATH' | 'known' | '', error }。
 */
export function resolveCursorAgent(configured, { env = process.env, platform = process.platform, exists = existsSync, home = homedir() } = {}) {
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const raw = String(configured || '').trim().replace(/^"(.*)"$/, '$1')
  if (raw) {
    if (p.isAbsolute(raw) && !exists(raw)) return { path: '', source: 'setting', error: `未找到 cursor-agent：设置的路径不存在（${raw}）。请检查「cursor-agent 路径」，或留空让插件自动查找。` }
    return { path: raw, source: 'setting', error: '' }
  }
  const names = win ? ['cursor-agent.cmd', 'cursor-agent.exe', 'cursor-agent.bat'] : ['cursor-agent']
  const pathKey = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH')
  const dirs = String((pathKey && env[pathKey]) || '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  for (const d of dirs) for (const n of names) { const f = p.join(d, n); if (exists(f)) return { path: f, source: 'PATH', error: '' } }
  const known = win
    ? [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'cursor-agent'), home && p.join(home, 'AppData', 'Local', 'cursor-agent'), home && p.join(home, '.local', 'bin')]
    : [home && p.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
  for (const d of known.filter(Boolean)) for (const n of names) { const f = p.join(d, n); if (exists(f)) return { path: f, source: 'known', error: '' } }
  return { path: '', source: '', error: '未找到 cursor-agent：请安装 Cursor CLI（cursor-agent）并加入 PATH，或在聊天室设置「cursor-agent 路径」中填写完整路径。' }
}

export const CURSOR_TOOL_NAME = 'cursor_handoff'

export const CURSOR_TOOL = {
  name: CURSOR_TOOL_NAME,
  description: [
    'Hand work to Cursor (headless cursor-agent) running on the owner\'s computer.',
    'Use action "brief" only after every AI in the room agrees on the plan: write a complete, self-contained English task brief (goal, context, exact changes, constraints, acceptance checks, what NOT to touch). Cursor cannot see this chat.',
    'Use action "read" for reading or summarising large amounts of code: describe what to read and what summary to return; Cursor will not modify files.',
    'Nothing runs until the owner replies 「执行」 in the room. The result (final text, git diff --stat, exit code) is posted back to the room for everyone.',
    'Set resume to a previous session_id to continue that Cursor session.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['brief', 'read'], description: '"brief" = implementation task; "read" = read/summarise code without editing.' },
      title: { type: 'string', description: 'Short title for the task.' },
      repo: { type: 'string', description: 'Absolute path of the target repository (working directory). Omit to use the room default.' },
      brief: { type: 'string', description: 'The full task brief / reading request, in English.' },
      resume: { type: 'string', description: 'Optional Cursor session_id to resume.' },
    },
    required: ['action', 'brief'],
  },
}

export const CURSOR_STDERR_NOISE = /(Anaconda[\\/]lib[\\/]site-packages[\\/]requests|RequestsDependencyWarning|warnings\.warn\("urllib3)/

/** 校验并整理 cursor_handoff 参数。 */
export function normalizeHandoffArgs(raw, { defaultRepo = '' } = {}) {
  let a = raw
  if (typeof a === 'string') { try { a = JSON.parse(a || '{}') } catch { return { error: 'arguments are not valid JSON' } } }
  if (!a || typeof a !== 'object') return { error: 'arguments must be an object' }
  const action = a.action === 'read' ? 'read' : a.action === 'brief' ? 'brief' : ''
  if (!action) return { error: 'action must be "brief" or "read"' }
  const brief = String(a.brief || '').trim()
  if (brief.length < 10) return { error: 'brief is empty or too short' }
  const repo = String(a.repo || defaultRepo || '').trim()
  if (!repo) return { error: 'no target repo: pass repo or set the default Cursor repo in settings' }
  return { action, title: String(a.title || '').trim().slice(0, 120) || (action === 'read' ? 'Code reading' : 'Implementation task'), repo, brief: brief.slice(0, 200000), resume: String(a.resume || '').trim().slice(0, 120) }
}

/** 实际送进 stdin 的提示（read 模式加只读约束）。 */
export function planText(h) {
  const head = h.action === 'read'
    ? 'READ-ONLY TASK. Do not create, modify or delete any files and do not run commands that change state. Read the code and reply with the requested summary.\n\n'
    : 'You are implementing a task agreed by a planning room. Follow the brief exactly; do not commit or push.\n\n'
  return `${head}# ${h.title}\n\n${h.brief}\n`
}

/** 桌面端 deeplink（只预填，不执行）。 */
export function cursorDeeplink(text) {
  return 'cursor://anysphere.cursor-deeplink/prompt?text=' + encodeURIComponent(String(text || '').slice(0, 7000))
}

/** stream-json 的一行 → 归一事件（未知行返回 null）。 */
export function parseCursorLine(line) {
  const t = String(line || '').trim()
  if (!t || t[0] !== '{') return null
  let ev
  try { ev = JSON.parse(t) } catch { return null }
  const out = { raw: ev, type: ev.type, subtype: ev.subtype }
  if (ev.session_id) out.sessionId = String(ev.session_id)
  if (ev.type === 'result') {
    out.result = typeof ev.result === 'string' ? ev.result : ''
    out.success = ev.subtype === 'success' && ev.is_error !== true
    if (ev.duration_ms != null) out.durationMs = ev.duration_ms
  } else if (ev.type === 'assistant') {
    const c = ev.message?.content
    out.text = Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('') : typeof c === 'string' ? c : ''
  } else if (ev.type === 'thinking') {
    // stream-json 下 cursor-agent 会发 thinking delta/completed（无需 --show-thinking；该旗标只用于 json）
    out.text = typeof ev.text === 'string' ? ev.text : ''
  } else if (ev.type === 'tool_call') {
    const tc = ev.tool_call || {}
    const key = Object.keys(tc)[0] || 'tool'
    const args = tc[key]?.args || {}
    out.tool = key.replace(/ToolCall$/, '')
    out.summary = String(args.path || args.filePath || args.file_path || args.targetDirectory || args.target_directory || args.command || args.pattern || args.globPattern || args.glob_pattern || args.query || args.url || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return out
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } resolve() }
  })
}

function git(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve(err && !stdout ? { ok: false, text: String(stderr || err.message || err).trim() } : { ok: true, text: String(stdout || '').replace(/\s+$/, '') })
    })
  })
}

/** git diff --stat（已跟踪文件），另附未跟踪的新文件（git diff 不显示它们；不改动索引）。 */
export async function gitDiffStat(cwd, timeoutMs = 20000) {
  const d = await git(cwd, ['diff', '--stat'], timeoutMs)
  if (!d.ok) return { ok: false, text: d.text.split(/\r?\n/)[0].slice(0, 300) }
  const u = await git(cwd, ['ls-files', '--others', '--exclude-standard'], timeoutMs)
  const untracked = u.ok && u.text ? u.text.split(/\r?\n/).filter(Boolean) : []
  const parts = [d.text]
  if (untracked.length) parts.push(`untracked (${untracked.length}): ` + untracked.slice(0, 40).join(', ') + (untracked.length > 40 ? ', …' : ''))
  return { ok: true, text: parts.filter(Boolean).join('\n').slice(0, 8000) }
}

/** git status --porcelain 的行；不是 git 仓库（或 git 不可用）时返回 null。 */
export async function gitStatusLines(cwd, timeoutMs = 20000) {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all'], timeoutMs)
  if (!r.ok) return null
  return r.text ? r.text.split(/\r?\n/).filter((l) => l.trim()) : []
}

/** 运行前后 git status 的差异：运行后新出现或状态变化的条目（运行前就已改动且未再变化的不算）。 */
export function changedBetween(before, after) {
  if (!Array.isArray(after)) return null
  const b = new Set(before || [])
  const a = new Set(after)
  const out = after.filter((l) => !b.has(l))
  const paths = new Set(after.map((l) => l.slice(3)))
  for (const l of before || []) if (!a.has(l) && !paths.has(l.slice(3))) out.push('(clean) ' + l.slice(3))
  return out
}

/** Cursor 任务卡片的全文（open_card / 界面分页读取）。英文标签，给 AI 和用户都能读。 */
export function cursorReport(result, { briefId = '', title = '', repo = '' } = {}) {
  const r = result || {}
  const lines = []
  lines.push(`Cursor task #${briefId}${title ? ' — ' + title : ''}`)
  lines.push(`Workspace: ${repo || r.repo || '?'}`)
  lines.push(`Status: ${r.status || 'unknown'} · exit code ${r.exitCode ?? '-'} · ${Math.round((Number(r.durationMs) || 0) / 1000)} s · ${r.toolCalls ?? 0} tool calls${r.sessionId ? ' · session ' + r.sessionId : ''}`)
  if (r.error) lines.push(`Error: ${r.error}`)
  lines.push('')
  lines.push('## Changed files (git status, before → after)')
  if (Array.isArray(r.changedFiles)) lines.push(r.changedFiles.length ? r.changedFiles.slice(0, 200).join('\n') + (r.changedFiles.length > 200 ? `\n… ${r.changedFiles.length - 200} more` : '') : '(no changes)')
  else lines.push('(not a git repository — no file comparison available)')
  if (String(r.diffStat || '').trim()) { lines.push(''); lines.push('## git diff --stat'); lines.push(String(r.diffStat).trim()) }
  lines.push('')
  lines.push('## Final report from cursor-agent')
  lines.push(String(r.finalText || '').trim() || '(cursor-agent returned no final message)')
  if (String(r.stderrTail || '').trim()) { lines.push(''); lines.push('## stderr (tail)'); lines.push(String(r.stderrTail).trim()) }
  return lines.join('\n')
}

/**
 * 运行 cursor-agent。返回 Promise<result>，result 是可无损 JSON 化的对象。
 * @param {{ agentPath: string, handoff: ReturnType<typeof normalizeHandoffArgs>, timeoutMs?: number, onProgress?: (p: {kind, text}) => void, signal?: AbortSignal, spawnImpl?: Function }} o
 */
export async function runCursorAgent(o) {
  // 先记下运行前的 git status，再启动 cursor-agent，才能比较「运行前 → 运行后」改了哪些文件。
  const repo = o?.handoff?.repo
  let beforeStatus = null
  try { if (repo && existsSync(repo) && statSync(repo).isDirectory()) beforeStatus = await gitStatusLines(repo) } catch {}
  return runCursorAgentCore({ ...o, beforeStatus })
}

function runCursorAgentCore({ agentPath, handoff, timeoutMs = 1800_000, onProgress = () => {}, signal, spawnImpl = spawn, env, beforeStatus = null }) {
  return new Promise((resolve) => {
    const cwd = handoff.repo
    const base = { action: handoff.action, title: handoff.title, repo: cwd }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return resolve(jsonSafe({ ...base, ok: false, status: 'error', error: `repo directory not found: ${cwd}` }))
    const agent = resolveCursorAgent(agentPath, { env: env ? { ...process.env, ...env } : process.env })
    if (!agent.path) return resolve(jsonSafe({ ...base, ok: false, status: 'error', error: agent.error }))
    agentPath = agent.path
    const args = ['-p', '--force', '--trust', '--output-format', 'stream-json']
    if (handoff.resume) args.push('--resume', handoff.resume)
    const quoted = /\s/.test(agentPath) && !/^".*"$/.test(agentPath) ? `"${agentPath}"` : agentPath
    let child
    try {
      child = spawnImpl(quoted, args, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (e) {
      return resolve(jsonSafe({ ...base, ok: false, status: 'error', error: `spawn failed: ${e?.message || e}` }))
    }
    const startedAt = Date.now()
    const st = { sessionId: '', resultEvent: null, texts: [], tools: 0, stderr: '', buf: '', exitCode: null, timedOut: false, aborted: false, lastAssistant: '', say: '', think: '' }
    const flushThink = () => {
      const think = st.think.replace(/\s+/g, ' ').trim(); st.think = ''
      // kind: 'thinking' 只进面板执行明细，不发 Telegram（与 say 相同）
      if (think) onProgress({ kind: 'thinking', text: think.length > 400 ? '…' + think.slice(-400) : think })
    }
    const onLine = (line) => {
      const ev = parseCursorLine(line)
      if (!ev) return
      if (ev.sessionId && !st.sessionId) { st.sessionId = ev.sessionId; onProgress({ kind: 'session', text: ev.sessionId }) }
      if (ev.type === 'thinking') {
        if (ev.subtype === 'delta' && ev.text) st.think = (st.think + ev.text).slice(-8000)
        else if (ev.subtype === 'completed') flushThink()
      } else if (ev.type === 'tool_call' && ev.subtype === 'started') {
        st.tools++
        flushThink()
        // 工具调用前的一段助手文字 → 简短进度（kind: 'say'，只进面板的执行明细，不发 Telegram）
        const say = st.say.replace(/\s+/g, ' ').trim(); st.say = ''
        if (say) onProgress({ kind: 'say', text: say.length > 200 ? '…' + say.slice(-200) : say })
        onProgress({ kind: 'tool', tool: ev.tool, target: ev.summary || '', text: `${ev.tool}${ev.summary ? ' ' + ev.summary : ''}` })
      }
      else if (ev.type === 'assistant' && ev.text) { st.lastAssistant += ev.text; st.say = (st.say + ev.text).slice(-4000) }
      else if (ev.type === 'result') { flushThink(); st.resultEvent = ev }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      st.buf += d
      let i
      while ((i = st.buf.indexOf('\n')) >= 0) { onLine(st.buf.slice(0, i)); st.buf = st.buf.slice(i + 1) }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      const kept = String(d).split(/\r?\n/).filter((l) => l.trim() && !CURSOR_STDERR_NOISE.test(l)).join('\n')
      if (kept) st.stderr = (st.stderr + '\n' + kept).slice(-4000)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(planText(handoff), 'utf8'))
    const timer = setTimeout(() => { st.timedOut = true; void killTree(child.pid) }, timeoutMs)
    const onAbort = () => { st.aborted = true; void killTree(child.pid) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    let settled = false
    const finish = async (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (st.buf.trim()) onLine(st.buf)
      st.exitCode = code
      const r = st.resultEvent
      const completed = !!(r && r.success) && !st.timedOut && !st.aborted
      const diff = await gitDiffStat(cwd)
      const changedFiles = changedBetween(beforeStatus, await gitStatusLines(cwd).catch(() => null))
      resolve(jsonSafe({
        ...base,
        ok: completed && code === 0,
        status: st.timedOut ? 'timeout' : st.aborted ? 'aborted' : completed ? 'success' : r ? 'failed' : 'no_result',
        exitCode: code,
        sessionId: st.sessionId || r?.sessionId || '',
        finalText: (r?.result || st.lastAssistant || '').slice(0, 30000),
        toolCalls: st.tools,
        durationMs: Date.now() - startedAt,
        diffStat: diff.text,
        ...(changedFiles ? { changedFiles: changedFiles.slice(0, 500) } : {}),
        ...(st.stderr.trim() ? { stderrTail: st.stderr.trim().slice(-2000) } : {}),
      }))
    }
    child.on('error', (e) => { st.stderr += `\n${e?.message || e}`; void finish(null) })
    child.on('close', (code) => { void finish(code) })
  })
}

/** 保证工具输出是无损 JSON（DSH isJsonValue）：经一次 JSON 往返，去掉 undefined / 非有限数字。 */
export function jsonSafe(value) {
  const v = JSON.parse(JSON.stringify(value, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x)) ?? 'null')
  if (!isJsonValue(v)) throw new Error('tool output is not a JSON value')
  return v
}

/**
 * Cursor 任务「执行明细」：记录进度事件（工具调用 / 简短助手文字 / 思考过程），只保留最近 limit 步；
 * snapshot() 给卡片数据（steps / stepsTotal / stepCounts / lastStep）。
 */
export function cursorStepTracker({ limit = 200, now = Date.now } = {}) {
  const steps = []
  const counts = {}
  let total = 0
  let last = ''
  return {
    add(p) {
      if (!p || (p.kind !== 'tool' && p.kind !== 'say' && p.kind !== 'thinking')) return null
      const t = new Date(now()).toISOString()
      let s
      if (p.kind === 'tool') {
        const tool = String(p.tool || String(p.text || '').split(' ')[0] || 'tool').slice(0, 40)
        const target = String(p.target != null ? p.target : String(p.text || '').slice(tool.length)).replace(/\s+/g, ' ').trim().slice(0, 160)
        s = { t, k: 'tool', tool, ...(target ? { target } : {}) }
        counts[tool] = (counts[tool] || 0) + 1
        last = (tool + (target ? ' ' + shortTarget(target) : '')).slice(0, 60)
      } else {
        const text = String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
        if (!text) return null
        s = { t, k: p.kind === 'thinking' ? 'thinking' : 'say', text }
      }
      total++
      steps.push(s)
      if (steps.length > limit) steps.splice(0, steps.length - limit)
      return s
    },
    get total() { return total },
    snapshot() { return { steps: steps.slice(), stepsTotal: total, stepCounts: { ...counts }, ...(last ? { lastStep: last } : {}) } },
  }
}
/** 路径只留最后一段（标题里的「最新一步」用）；命令保留开头。 */
function shortTarget(s) {
  const t = String(s || '').trim()
  if (/^[A-Za-z]:[\\/]|^[\\/]/.test(t) && !/\s/.test(t)) return t.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || t
  return t.length > 40 ? t.slice(0, 40) + '…' : t
}
/** AI 看到的紧凑步骤摘要：按工具计数（不是逐条明细）。 */
export function stepCountsLine(counts, total) {
  const e = Object.entries(counts || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!e.length) return ''
  return `Cursor steps: ${e.slice(0, 12).map(([k, n]) => `${k}×${n}`).join(', ')}${e.length > 12 ? ', …' : ''} (${e.reduce((a, [, n]) => a + n, 0)} tool calls)`
}

/** Telegram 上的一行摘要。 */
/** Telegram / 面板：任务书正文（含编号与标题；过长由 splitForTelegram 切分）。 */
export function briefRelayLine(m) {
  const id = m?.briefId ? '#' + m.briefId : ''
  const title = String(m?.title || '').trim()
  const body = String(m?.text || '').trim()
  const head = ['📋 任务书', id, title ? '· ' + title : ''].filter(Boolean).join(' ')
  return body ? head + '\n\n' + body : head
}

export function toolSummaryLine(m) {
  const d = m.data || {}
  if (m.tool === CURSOR_TOOL_NAME) {
    if (d.status === 'awaiting_owner') return `🛠 ${m.speaker?.name || ''} 提交了 Cursor 任务书 #${d.briefId}：${d.title}（待所有者回复「执行」）`
    if (d.status === 'running') return `🛠 Cursor 任务 #${d.briefId} 开始执行：${d.briefTitle || d.title}`
    if (d.status === 'cancelled') return `🛠 Cursor 任务 #${d.briefId || ''} 已取消`
    if (d.status === 'fused') return `🛠 Cursor 任务 #${d.briefId || ''} 已熔断`
    if (d.status === 'interrupted') return `🛠 Cursor 任务 #${d.briefId || ''} 状态未知（DSH 在运行期间重启）`
    const files = (String(d.diffStat || '').trim().split('\n').pop() || '').trim()
    return `🛠 Cursor 任务 #${d.briefId || ''} ${d.status === 'success' ? '已完成' : '结束（' + d.status + '）'}，退出码 ${d.exitCode ?? '-'}${files ? '；' + files : ''}`
  }
  const who = m.speaker?.name ? `${m.speaker.name} ` : ''
  if (m.tool === 'find_tools') return `🔎 ${who}查找工具：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}`
  const id = d.resultId ? ` #${d.resultId}` : ''
  return `🛠 ${who}调用 ${m.tool}${id}${d.ok === false ? '（失败）' : ''}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 100)}`
}

/** Brief statuses that the owner can continue (「执行」 / UI 「继续」) without hand-editing meta. */
export const CURSOR_BRIEF_CONTINUABLE = new Set(['awaiting_owner', 'interrupted', 'shutdown', 'fused', 'no_result', 'timeout', 'aborted'])

/** Formal Chinese labels for Cursor brief statuses (UI). */
export const CURSOR_BRIEF_STATUS_LABEL = {
  awaiting_owner: '待执行',
  running: '进行中',
  success: '已完成',
  failed: '失败',
  error: '失败',
  cancelled: '已取消',
  stopped: '已取消',
  interrupted: '状态未知（已中断）',
  shutdown: '状态未知（已中断）',
  fused: '已熔断',
  no_result: '无结果',
  timeout: '超时',
  aborted: '已中止',
}

export function briefStatusLabel(status) {
  const st = String(status || '').trim()
  if (!st) return CURSOR_BRIEF_STATUS_LABEL.awaiting_owner
  return CURSOR_BRIEF_STATUS_LABEL[st] || '未知'
}

export function isBriefContinuable(status) {
  return CURSOR_BRIEF_CONTINUABLE.has(String(status || '').trim())
}

/**
 * List Cursor briefs from room meta for the session-record UI / API.
 * Newest first. Does not invent briefs that are not in meta.
 */
export function listRoomBriefs(meta, { seats = [] } = {}) {
  const seatName = (id) => {
    const s = (seats || []).find((x) => x && x.id === id)
    return s?.name || id || ''
  }
  const briefs = meta?.briefs && typeof meta.briefs === 'object' ? meta.briefs : {}
  const pendingBrief = meta?.pendingBrief || null
  const items = Object.entries(briefs).map(([id, b]) => {
    const status = String(b?.status || 'awaiting_owner')
    const at = b?.at || b?.runner?.startedAt || null
    return {
      id,
      title: b?.title || '',
      action: b?.action || 'brief',
      repo: b?.repo || '',
      status,
      statusLabel: briefStatusLabel(status),
      by: b?.by || '',
      byName: seatName(b?.by),
      at,
      cardId: b?.cardId || null,
      msgId: b?.msgId || null,
      sessionId: b?.sessionId || '',
      pending: pendingBrief === id,
      continuable: isBriefContinuable(status),
      cancellable: status === 'awaiting_owner' || status === 'running',
    }
  })
  items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || String(b.id).localeCompare(String(a.id)))
  return { pendingBrief, items }
}
