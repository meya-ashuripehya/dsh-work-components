/**
 * Cursor 交接：cursor_handoff 工具定义、任务书、headless cursor-agent 运行、桌面端 deeplink。
 *
 * 运行（仅在所有者回复「执行」后）：
 *   spawn(<cursor-agent.cmd>, ['-p','--force','--trust','--output-format','stream-json', (--resume <id>)], { shell: true, cwd: 目标仓库 })
 *   任务书经 stdin 写入（避开 Windows 8 KB 命令行上限），UTF-8；stdout 按行解析 JSON：
 *     system/init → session_id；tool_call started/completed → 简短进度；assistant → 文本；result → 最终结果。
 *   完成 = 收到 result 事件（subtype success）且进程退出。超时 → taskkill /T /F 结束整个进程树。
 *   stderr 只留尾部（PowerShell 会话里那条 S:\Anaconda requests 警告无害，过滤掉不报）。
 *   结束后在 cwd 跑 git diff --stat，连同最终文本、退出码、session_id 回报房间。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isJsonValue } from '../../vendor/dsh-tools/util-values.js'

export const CURSOR_TOOL_NAME = 'cursor_handoff'

export const CURSOR_TOOL = {
  name: CURSOR_TOOL_NAME,
  description: [
    'Hand work to Cursor (headless cursor-agent) running on the owner\'s computer.',
    'Use action "brief" only after every AI in the room agrees on the plan: write a complete, self-contained English task brief (goal, context, exact changes, constraints, acceptance checks, what NOT to touch). Cursor cannot see this chat.',
    'Use action "read" for reading or summarising large amounts of code: describe what to read and what summary to return; Cursor will not modify files.',
    'Nothing runs until the owner (Shiro) replies 「执行」 in the room. The result (final text, git diff --stat, exit code) is posted back to the room for everyone.',
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
  } else if (ev.type === 'tool_call') {
    const tc = ev.tool_call || {}
    const key = Object.keys(tc)[0] || 'tool'
    const args = tc[key]?.args || {}
    out.tool = key.replace(/ToolCall$/, '')
    out.summary = String(args.path || args.command || args.pattern || args.query || args.url || '').slice(0, 120)
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

/**
 * 运行 cursor-agent。返回 Promise<result>，result 是可无损 JSON 化的对象。
 * @param {{ agentPath: string, handoff: ReturnType<typeof normalizeHandoffArgs>, timeoutMs?: number, onProgress?: (p: {kind, text}) => void, signal?: AbortSignal, spawnImpl?: Function }} o
 */
export function runCursorAgent({ agentPath, handoff, timeoutMs = 1800_000, onProgress = () => {}, signal, spawnImpl = spawn, env }) {
  return new Promise((resolve) => {
    const cwd = handoff.repo
    const base = { action: handoff.action, title: handoff.title, repo: cwd }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return resolve(jsonSafe({ ...base, ok: false, status: 'error', error: `repo directory not found: ${cwd}` }))
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
    const st = { sessionId: '', resultEvent: null, texts: [], tools: 0, stderr: '', buf: '', exitCode: null, timedOut: false, aborted: false, lastAssistant: '' }
    const onLine = (line) => {
      const ev = parseCursorLine(line)
      if (!ev) return
      if (ev.sessionId && !st.sessionId) { st.sessionId = ev.sessionId; onProgress({ kind: 'session', text: ev.sessionId }) }
      if (ev.type === 'tool_call' && ev.subtype === 'started') { st.tools++; onProgress({ kind: 'tool', text: `${ev.tool}${ev.summary ? ' ' + ev.summary : ''}` }) }
      else if (ev.type === 'assistant' && ev.text) st.lastAssistant += ev.text
      else if (ev.type === 'result') st.resultEvent = ev
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

/** Telegram 上的一行摘要。 */
export function toolSummaryLine(m) {
  const d = m.data || {}
  if (m.tool === CURSOR_TOOL_NAME) {
    if (d.status === 'awaiting_owner') return `🛠 ${m.speaker?.name || ''} 提交了 Cursor 任务书 #${d.briefId}：${d.title}（待 Shiro 回复「执行」）`
    if (d.status === 'running') return `🛠 Cursor 任务 #${d.briefId} 开始执行：${d.title}`
    const files = (String(d.diffStat || '').trim().split('\n').pop() || '').trim()
    return `🛠 Cursor 任务 #${d.briefId || ''} ${d.status === 'success' ? '已完成' : '结束（' + d.status + '）'}，退出码 ${d.exitCode ?? '-'}${files ? '；' + files : ''}`
  }
  return `🛠 ${m.tool}：${String(m.text || '').slice(0, 120)}`
}
