/** 出厂模板 id（空模板，provider/model/dshPreset 均为 null）。 */
export const TEMPLATE_IDS = ['profile_default', 'profile_brief', 'profile_mc']

export function blankProfileConfig() {
  return {
    provider: null,
    model: null,
    dshPreset: null,
    reasoningEffort: 'none',
    temperature: null,
    maxTokens: null,
    personaAppend: '',
  }
}

const FACTORY_META = [
  { id: 'profile_default', name: '通用助手' },
  { id: 'profile_brief', name: '简短回答' },
  { id: 'profile_mc', name: 'MC 角色' },
]

/** 全新 profiles.json 的初始内容（含 templates.nextSeq 与三条出厂模板）。 */
export function createSeedStore(now = new Date().toISOString()) {
  const templates = {}
  for (const id of TEMPLATE_IDS) templates[id] = { nextSeq: 1 }
  return {
    version: 1,
    updatedAt: now,
    templates,
    profiles: FACTORY_META.map(({ id, name }) => ({
      id,
      name,
      builtin: true,
      template: true,
      createdAt: now,
      updatedAt: now,
      config: blankProfileConfig(),
    })),
  }
}
