/**
 * 共享房间记录 → 某一席位的调用输入：
 *   system = 内置角色规则 + 成员名册（擅长 / 偏好）+ 附加房间规则 + 预设人设 + 席位附加人设
 *   messages = 多人对话稿：他人发言 → user 角色并带「[名字] 」前缀；自己的历史 → assistant；
 *              工具输出（无论谁调用）→ user 角色「[tool:名称 by 调用者] JSON」，所有 AI 都能看到。
 * 同角色相邻消息合并，首条必须是 user，末条若是自己则补一句提示。
 */
import { PASS_TOKEN, isPass, stripSelfPrefix } from './directives.mjs'

export { PASS_TOKEN, isPass, stripSelfPrefix }

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,，、\n]+/)).map((s) => String(s).trim()).filter(Boolean)

export function rosterLines(seats, userName) {
  const lines = [`- ${userName} (human owner): sets goals, approves budgets and execution.`]
  for (const s of seats.filter((x) => x.enabled !== false)) {
    const bits = []
    if (list(s.talents).length) bits.push(`good at: ${list(s.talents).join(', ')}`)
    if (list(s.prefer).length) bits.push(`prefers to join: ${list(s.prefer).join(', ')}`)
    if (list(s.rarely).length) bits.push(`rarely joins: ${list(s.rarely).join(', ')}`)
    if (list(s.never).length) bits.push(`never joins: ${list(s.never).join(', ')}`)
    if (s.leader) bits.push('leader (drafts Cursor task briefs)')
    lines.push(`- ${s.name}${bits.length ? ': ' + bits.join('; ') : ''}`)
  }
  return lines
}

export function roomRules({ seat, seats, userName, rules, mainName, turnInfo }) {
  const others = seats.filter((s) => s.id !== seat.id && s.enabled !== false).map((s) => s.name)
  const lines = [
    `You are ${seat.name}, one participant in a shared multi-AI planning room with ${userName}${others.length ? ' and the other AIs: ' + others.join(', ') : ''}.`,
    'Reply in Chinese first (keep code, identifiers and English terms as they are).',
    '',
    'Role rules:',
    `- You are a planning participant, like ${userName}: discuss, analyse, design, review and decide. You are NOT the implementer.`,
    '- Do not edit files, run commands or change the computer yourself, unless the owner explicitly asks YOU (by name) to do so.',
    '- Implementation is handed to Cursor via the cursor_handoff tool, and only after every AI agrees and the owner replies 「执行」.',
    '- Tool outputs in this room are visible to everyone, whoever called the tool. Read them before speaking.',
    '- Each message from others starts with "[name] ". Your own past messages have no prefix. Never write lines for others and never prefix your reply with your own name.',
    '- Keep it short, like a group chat. Do not repeat what others already said.',
    `- If you have nothing worth adding this turn, reply exactly ${PASS_TOKEN} (it is silent; nobody sees it).`,
    '- To hand the next turn to someone better suited, end your message with [[NEXT: Name]] (e.g. [[NEXT: Gemini]]).',
    '- Respect the roster preferences below: avoid topics you "never" join, rarely speak on "rarely" topics.',
  ]
  if (seat.leader) {
    lines.push('- You are the leader. When all AIs agree on an implementation plan, call cursor_handoff with action "brief" (a complete, self-contained English task brief for Cursor). For reading/summarising large code, call it with action "read". It is only executed after the owner replies 「执行」.')
  }
  if (mainName) lines.push('', `Main answerer for the current task: ${mainName}.${mainName === seat.name ? ' That is you: give the main answer.' : ''}`)
  if (turnInfo) lines.push(turnInfo)
  lines.push('', 'Roster:', ...rosterLines(seats, userName))
  if (String(rules || '').trim()) lines.push('', 'Extra room rules:', String(rules).trim())
  if (String(seat.presetPersona || '').trim()) lines.push('', `Your persona (from DSH preset ${seat.preset}; your name in this room is still ${seat.name}):`, String(seat.presetPersona).trim())
  if (String(seat.persona || '').trim()) lines.push('', seat.presetPersona ? 'Additional instructions:' : 'Your persona:', String(seat.persona).trim())
  return lines.join('\n')
}

const VISIBLE = new Set(['ok', 'stopped'])

function lineOf(m, userName) {
  if (m.kind === 'tool') {
    let body = ''
    try { body = JSON.stringify(m.data ?? null) } catch { body = '' }
    if (body.length > 12000) body = body.slice(0, 12000) + '…(truncated in prompt; full JSON is in the room log)'
    return `[tool:${m.tool || 'tool'} by ${m.speaker?.name || '?'}] ${m.text ? m.text + '\n' : ''}${body}`
  }
  if (m.kind === 'brief') return `[${m.speaker?.name || '?'}] (Cursor task brief #${m.briefId}, status: ${m.briefStatus || 'pending'})\n${m.text}`
  return `[${m.speaker?.name || (m.kind === 'user' ? userName : '?')}] ${m.text}`
}

/**
 * @param {{ seat, seats, userName, rules?, messages, maxHistory?, mainName?, turnInfo?, extraUser? }} input
 * @returns {{ system: string, messages: { role: 'user'|'assistant', content: string }[] }}
 */
export function buildPrompt({ seat, seats, userName, rules, messages, maxHistory = 0, mainName, turnInfo, extraUser }) {
  let log = (messages || []).filter((m) =>
    ((m.kind === 'user' || m.kind === 'seat' || m.kind === 'brief') && VISIBLE.has(m.status || 'ok') && String(m.text || '').trim()) ||
    (m.kind === 'tool' && m.status !== 'hidden'))
  if (maxHistory > 0 && log.length > maxHistory) log = log.slice(-maxHistory)
  const out = []
  for (const m of log) {
    const own = m.kind === 'seat' && m.speaker?.id === seat.id
    const role = own ? 'assistant' : 'user'
    const content = own ? m.text : lineOf(m, userName)
    const last = out[out.length - 1]
    if (last && last.role === role) last.content += '\n\n' + content
    else out.push({ role, content })
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: `[${userName}] (conversation start)` })
  if (extraUser) {
    if (out[out.length - 1].role === 'user') out[out.length - 1].content += '\n\n' + extraUser
    else out.push({ role: 'user', content: extraUser })
  } else if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: '(your turn)' })
  return { system: roomRules({ seat, seats, userName, rules, mainName, turnInfo }), messages: out }
}
