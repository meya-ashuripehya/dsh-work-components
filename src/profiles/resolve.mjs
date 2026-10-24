/**
 * 合并档案 config 与消费者 overrides（白名单）。唯一有效配置入口。
 */
export function resolveProfile(profile, overrides = {}) {
  const out = structuredClone(profile.config)
  for (const k of ['temperature', 'maxTokens', 'reasoningEffort']) {
    if (overrides[k] != null) out[k] = overrides[k]
  }
  const parts = [out.personaAppend, overrides.personaAppend].filter((s) => s && s.trim())
  out.personaAppend = parts.join('\n')
  return out
}
