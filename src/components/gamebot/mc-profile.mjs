/**
 * 控制会话用档案库的 provider / model。MC 行只存 profileId，不存人设正文或密钥。
 */
import { resolveProfile } from '../../profiles/resolve.mjs'
import { getProfile } from '../../profiles/store.mjs'
import { activeAgents } from './agents.mjs'

export function profileChoices(profiles) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((item) => item && item.template !== true)
    .map((item) => ({ id: String(item.id), name: String(item.name || item.id) }))
}

export async function modelForSeat(cfg, memberId, root) {
  const agent = activeAgents(cfg).find((item) => item.code === memberId)
  if (!agent) return { error: '这个席位没有启用的 Minecraft AI' }
  if (!agent.profileId) {
    if (!agent.provider || !agent.model) return { error: '这个席位还没有服务商或档案' }
    return {
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort || '',
      persona: '',
      name: agent.name,
      profileId: '',
    }
  }
  let profile
  try {
    profile = await getProfile(agent.profileId, root)
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
    name: agent.name,
    profileId: profile.id,
  }
}
