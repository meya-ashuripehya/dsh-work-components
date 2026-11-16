/** Local-only control plane for channel conversation → DSH session bindings. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises'

const home = () => join(homedir(), '.dsh')
const bindingsFile = () => join(home(), 'dsh-channels', 'bindings.json')
const workspaceFile = () => join(home(), 'storages', 'workspace.json')
const projectionsDir = () => join(home(), 'storages', 'session_projcache', 'sessions')
let writes = Promise.resolve()

async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}
const text = (v) => typeof v === 'string' ? v.trim() : ''

export async function listChannelBindings(channelId, accountId = '') {
  const all = await json(bindingsFile(), {})
  return Object.entries(all).filter(([, b]) => b && b.channelId === channelId && (!accountId || b.accountId === accountId))
    .map(([key, b]) => ({ key, ...b })).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

export async function listSessionChoices({ includeArchived = false } = {}) {
  const [workspace, names] = await Promise.all([json(workspaceFile(), {}), readdir(projectionsDir()).catch(() => [])])
  const archived = new Set(workspace?.global?.archivedSessionIds || [])
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    const p = await json(join(projectionsDir(), name), null)
    const rows = p?.record?.rows
    if (!rows) continue
    const isArchived = archived.has(id)
    if (isArchived && !includeArchived) continue
    const title = text(rows.title?.val) || text(rows.titleInput?.val?.first?.text) || '未命名会话'
    out.push({ id, title: title.slice(0, 160), preset: text(rows.agentPreset?.val), cwd: text(p?.record?.identity?.cwd), archived: isArchived, lastPromptAt: Number(rows.sessionListMetadata?.val?.lastPromptAt || 0) || 0 })
  }
  return out.sort((a, b) => b.lastPromptAt - a.lastPromptAt || a.title.localeCompare(b.title))
}

/** Repoint an already-known external conversation. It mirrors /bind's safety rules. */
export async function rebindChannelConversation({ key, sessionId }) {
  key = text(key); sessionId = text(sessionId)
  if (!key || !sessionId) throw Object.assign(new Error('需要会话绑定键和 DSH 会话 ID'), { status: 400 })
  const choices = await listSessionChoices({ includeArchived: true })
  const target = choices.find((x) => x.id === sessionId)
  if (!target) throw Object.assign(new Error('目标 DSH 会话不存在或没有可用投影'), { status: 404 })
  let result
  writes = writes.catch(() => {}).then(async () => {
    const file = bindingsFile(); const all = await json(file, {})
    const current = all[key]
    if (!current || typeof current !== 'object') throw Object.assign(new Error('外部聊天绑定不存在；请先向该机器人发送一条消息'), { status: 404 })
    const elsewhere = Object.entries(all).find(([otherKey, b]) => otherKey !== key && b?.sessionId === sessionId)
    if (elsewhere) throw Object.assign(new Error('目标 DSH 会话已绑定到另一条外部聊天，已拒绝重复绑定'), { status: 409 })
    const next = { ...current, sessionId, updatedAt: Date.now() }
    all[key] = next
    await mkdir(join(home(), 'dsh-channels'), { recursive: true })
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8')
    await rename(tmp, file)
    result = { key, binding: next, session: target }
  })
  await writes
  return result
}
