/**
 * AI 档案：数据落在数据目录 profiles/profiles.json，先写临时文件再替换；
 * 同一进程内的读写串行执行。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { ProfileError } from './errors.mjs'
import { blankProfileConfig, createSeedStore, TEMPLATE_IDS } from './seed.mjs'

let tail = Promise.resolve()

function exclusive(fn) {
  const run = tail.then(fn, fn)
  tail = run.then(() => undefined, () => undefined)
  return run
}

export function profilesFile(root) {
  return join(root || dataDir(), 'profiles', 'profiles.json')
}

/** 覆盖写之前备份旧文件，最多保留 PROFILE_BACKUP_KEEP 份（只清理自己生成的 .bak-<时间戳>）。 */
const PROFILE_BACKUP_KEEP = 10

function backupBeforeOverwrite(file) {
  let previous
  try {
    previous = readFileSync(file, 'utf8')
  } catch {
    return null // 文件不存在：没有可备份的东西
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}-auto`
  try {
    writeFileSync(target, previous, 'utf8')
  } catch {
    return null
  }
  try {
    const dir = dirname(file)
    const prefix = `${basename(file)}.bak-`
    const owned = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && /\d{4}-\d{2}-\d{2}T/.test(name))
      .sort()
    for (const name of owned.slice(0, Math.max(0, owned.length - PROFILE_BACKUP_KEEP))) {
      rmSync(join(dir, name), { force: true })
    }
  } catch {
    /* 清理失败不影响写入 */
  }
  return target
}

function replaceFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  // 内容没变就不写，也不产生备份。
  try {
    if (readFileSync(file, 'utf8') === text) return
  } catch {
    /* 不存在则继续写 */
  }
  backupBeforeOverwrite(file)
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    const old = file + '.old'
    let backedUp = false
    try {
      renameSync(file, old)
      backedUp = true
      renameSync(tmp, file)
      rmSync(old, { force: true })
    } catch (err) {
      if (backedUp) {
        try {
          rmSync(file, { force: true })
          renameSync(old, file)
        } catch {
          /* 尽力回滚 */
        }
      }
      throw err
    }
  }
}

function normalizeTemplates(raw) {
  const templates = {}
  for (const id of TEMPLATE_IDS) {
    const seq = raw?.[id]?.nextSeq
    templates[id] = { nextSeq: typeof seq === 'number' && seq >= 1 ? Math.floor(seq) : 1 }
  }
  return templates
}

function normalizeProfile(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = String(entry.id ?? '').trim()
  if (!id) return null
  const base = blankProfileConfig()
  const cfg = entry.config && typeof entry.config === 'object' ? entry.config : {}
  const config = {
    provider: cfg.provider === undefined ? base.provider : cfg.provider,
    model: cfg.model === undefined ? base.model : cfg.model,
    dshPreset: cfg.dshPreset === undefined ? base.dshPreset : cfg.dshPreset,
    reasoningEffort: cfg.reasoningEffort === undefined ? base.reasoningEffort : cfg.reasoningEffort,
    temperature: cfg.temperature === undefined ? base.temperature : cfg.temperature,
    maxTokens: cfg.maxTokens === undefined ? base.maxTokens : cfg.maxTokens,
    personaAppend: cfg.personaAppend === undefined ? base.personaAppend : String(cfg.personaAppend ?? ''),
  }
  const profile = {
    id,
    name: String(entry.name ?? id).trim() || id,
    builtin: entry.builtin === true,
    createdAt: String(entry.createdAt ?? ''),
    updatedAt: String(entry.updatedAt ?? ''),
    config,
  }
  profile.template = entry.template === true
  if (Array.isArray(entry.tags) && entry.tags.length) profile.tags = entry.tags.map((t) => String(t))
  return profile
}

function readStore(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return createSeedStore()
    throw new ProfileError('档案文件无法读取', 500)
  }
  try {
    const data = JSON.parse(raw)
    const profiles = Array.isArray(data?.profiles) ? data.profiles.map(normalizeProfile).filter(Boolean) : []
    return {
      version: typeof data?.version === 'number' ? data.version : 1,
      updatedAt: String(data?.updatedAt ?? ''),
      templates: normalizeTemplates(data?.templates),
      profiles,
    }
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const broken = join(dirname(file), `profiles.broken-${stamp}.json`)
    try {
      renameSync(file, broken)
    } catch {
      /* 无法备份时仍恢复出厂种子，避免入口永久 500 */
    }
    console.warn(`档案文件已损坏，已备份为 ${broken}，已恢复出厂模板。`)
    return createSeedStore()
  }
}

function writeStore(file, store) {
  const payload = {
    version: store.version ?? 1,
    updatedAt: store.updatedAt ?? new Date().toISOString(),
    templates: store.templates,
    profiles: store.profiles,
  }
  replaceFile(file, JSON.stringify(payload, null, 2) + '\n')
}

function findProfile(store, id) {
  const profileId = String(id ?? '').trim()
  if (!profileId) return null
  return store.profiles.find((p) => p.id === profileId) || null
}

function findTemplate(store, templateId) {
  const profile = findProfile(store, templateId)
  if (!profile?.template) return null
  return profile
}

/** 若 profiles.json 不存在则写入出厂种子。 */
export function ensureProfilesStore(root) {
  return exclusive(async () => {
    const file = profilesFile(root)
    try {
      readFileSync(file, 'utf8')
      return { seeded: false }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const seed = createSeedStore()
      writeStore(file, seed)
      return { seeded: true }
    }
  })
}

export function loadProfilesStore(root) {
  return exclusive(async () => readStore(profilesFile(root)))
}

export function getProfile(id, root) {
  return exclusive(async () => {
    const store = readStore(profilesFile(root))
    const profile = findProfile(store, id)
    if (!profile) throw new ProfileError('没有这条档案', 404)
    return profile
  })
}

export function listProfiles(root) {
  return exclusive(async () => {
    const store = readStore(profilesFile(root))
    return store.profiles.slice()
  })
}

/**
 * 从出厂模板实体化为用户档案：id 为 `<templateId>-<n>`，n 来自 templates[templateId].nextSeq（只增不复用）。
 */
export function materializeProfile(templateId, input, root) {
  return exclusive(async () => {
    const tid = String(templateId ?? '').trim()
    if (!tid) throw new ProfileError('需要模板 id')
    const file = profilesFile(root)
    const store = readStore(file)
    const template = findTemplate(store, tid)
    if (!template) throw new ProfileError('不是可用的出厂模板', 404)

    const name = String(input?.name ?? '').trim()
    if (!name) throw new ProfileError('档案名称不能为空')

    const provider = input?.provider === undefined ? null : input.provider
    const model = input?.model === undefined ? null : input.model
    const dshPreset = input?.dshPreset === undefined ? null : input.dshPreset
    if (provider == null || model == null) throw new ProfileError('需要选择服务商与模型')
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw new ProfileError('需要选择服务商与模型')
    }
    if (!provider.trim() || !model.trim()) throw new ProfileError('需要选择服务商与模型')

    const slot = store.templates[tid]
    if (!slot) throw new ProfileError('模板序号状态缺失', 500)
    const n = slot.nextSeq
    slot.nextSeq = n + 1

    const now = new Date().toISOString()
    const config = blankProfileConfig()
    config.provider = provider
    config.model = model
    config.dshPreset = dshPreset
    if (input?.reasoningEffort != null) config.reasoningEffort = input.reasoningEffort
    if (input?.personaAppend != null) config.personaAppend = String(input.personaAppend)

    const profile = {
      id: `${tid}-${n}`,
      name,
      builtin: false,
      template: false,
      createdAt: now,
      updatedAt: now,
      config,
    }

    store.profiles.push(profile)
    store.updatedAt = now
    writeStore(file, store)
    return profile
  })
}

/**
 * 测试用：从存储中移除一条用户档案（不回收序号）。
 * 生产删除 API 须实现设计文档 §9（被引用档案拒绝删除）；本函数不做引用检查。
 */
export function deleteProfileForTest(id, root) {
  return exclusive(async () => {
    const profileId = String(id ?? '').trim()
    if (!profileId) throw new ProfileError('需要档案 id')
    const file = profilesFile(root)
    const store = readStore(file)
    const target = findProfile(store, profileId)
    if (!target) throw new ProfileError('没有这条档案', 404)
    if (target.builtin || target.template) throw new ProfileError('出厂档案不能删除')
    store.profiles = store.profiles.filter((p) => p.id !== profileId)
    store.updatedAt = new Date().toISOString()
    writeStore(file, store)
    return { id: profileId }
  })
}
