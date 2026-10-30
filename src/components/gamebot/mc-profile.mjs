/**
 * 控制会话用档案库的 provider / model。席位上的 profileId 指向档案库；人设与密钥不写进席位。
 * 旧 Minecraft AI 表仍可作为 profileId / 名称的回退。
 */
import { resolveProfile } from '../../profiles/resolve.mjs'
import { getProfile } from '../../profiles/store.mjs'
import { activeAgents } from './agents.mjs'
import { memberIdsFor } from './members.mjs'

export function profileChoices(profiles) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((item) => item && item.template !== true)
    .map((item) => ({ id: String(item.id), name: String(item.name || item.id) }))
}

export async function modelForSeat(cfg, memberId, root) {
  const id = String(memberId || '').trim()
  const pool = Array.isArray(cfg?.chatroomSeats) ? cfg.chatroomSeats : []
  const seat = pool.find((item) => item && String(item.id) === id)
  const agent = activeAgents(cfg).find((item) => item.code === id)
  const onRoster = memberIdsFor(cfg).includes(id) || !!agent
  if (!onRoster && !seat) return { error: '这个席位没有启用的 Minecraft AI' }
  const profileId = String(seat?.profileId || agent?.profileId || '').trim()
  const name = String(seat?.name || agent?.name || id)
  const provider = String(seat?.provider || agent?.provider || '').trim()
  const model = String(seat?.model || agent?.model || '').trim()
  const reasoningEffort = String(seat?.reasoningEffort || agent?.reasoningEffort || '')
  if (!profileId) {
    if (!provider || !model) return { error: '这个席位还没有服务商或档案' }
    return { provider, model, reasoningEffort, persona: '', name, profileId: '' }
  }
  let profile
  try {
    profile = await getProfile(profileId, root)
  } catch {
    return { error: '所选档案不存在，请重新选择个人档案' }
  }
  if (profile.template) return { error: '不能直接使用出厂模板，请先复制成个人档案' }
  const resolved = resolveProfile(profile, {})
  if (!resolved.provider || !resolved.model) return { error: '档案里没有服务商或模型' }
  return {
    provider: resolved.provider,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort || '',
    persona: resolved.personaAppend || '',
    name,
    profileId: profile.id,
  }
}
