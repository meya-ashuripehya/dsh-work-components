import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProfile } from './resolve.mjs'
import { createSeedStore } from './seed.mjs'
import {
  deleteProfileForTest,
  ensureProfilesStore,
  getProfile,
  listProfiles,
  loadProfilesStore,
  materializeProfile,
  profilesFile,
} from './store.mjs'

test('resolveProfile：personaAppend 追加不替换，白名单覆盖生效', () => {
  const profile = {
    config: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      dshPreset: 'DeepSeek',
      reasoningEffort: 'none',
      temperature: null,
      maxTokens: null,
      personaAppend: '档案附加',
    },
  }
  const out = resolveProfile(profile, {
    maxTokens: 400,
    personaAppend: '成员附加',
  })
  assert.equal(out.maxTokens, 400)
  assert.equal(out.provider, 'deepseek')
  assert.equal(out.personaAppend, '档案附加\n成员附加')
  assert.equal(resolveProfile(profile, { temperature: 0.2 }).temperature, 0.2)
  assert.equal(resolveProfile(profile, { temperature: null }).temperature, null)
})

test('createSeedStore：三条出厂模板保持空白 config', () => {
  const seed = createSeedStore('2026-10-21T08:00:00.000Z')
  assert.equal(seed.version, 1)
  assert.deepEqual(seed.templates, {
    profile_default: { nextSeq: 1 },
    profile_brief: { nextSeq: 1 },
    profile_mc: { nextSeq: 1 },
  })
  assert.equal(seed.profiles.length, 3)
  for (const p of seed.profiles) {
    assert.equal(p.builtin, true)
    assert.equal(p.template, true)
    assert.equal(p.config.provider, null)
    assert.equal(p.config.model, null)
    assert.equal(p.config.dshPreset, null)
  }
})

test('replaceFile：兜底路径先备份为 .old，不先 rm 主文件', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'store.mjs'), 'utf8')
  const fn = src.slice(src.indexOf('function replaceFile'), src.indexOf('function normalizeTemplates'))
  assert.ok(fn.includes('renameSync(file, old)'))
  assert.ok(!/\brmSync\(file,\s*\{\s*force:\s*true\s*\}\)\s*\n\s*renameSync\(tmp,\s*file\)/.test(fn))
})

test('坏 JSON：备份为 profiles.broken-* 并恢复出厂种子', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profiles-broken-'))
  try {
    const file = profilesFile(root)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ not json', 'utf8')
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    const store = await loadProfilesStore(root)
    console.warn = origWarn
    assert.equal(store.profiles.length, 3)
    assert.equal(store.profiles.every((p) => p.template === true), true)
    const broken = readdirSync(dirname(file)).filter((name) => name.startsWith('profiles.broken-'))
    assert.equal(broken.length, 1)
    assert.ok(warnings.some((w) => w.includes('档案文件已损坏')))
    assert.equal(readdirSync(dirname(file)).includes('profiles.json'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('template 字段：实体化档案落盘再读回仍为 false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profiles-template-'))
  try {
    await ensureProfilesStore(root)
    const created = await materializeProfile(
      'profile_default',
      { name: '带 template 字段', provider: 'deepseek', model: 'deepseek-chat', dshPreset: 'DeepSeek' },
      root,
    )
    assert.equal(created.template, false)
    const again = await getProfile(created.id, root)
    assert.equal(again.template, false)
    const onDisk = JSON.parse(readFileSync(profilesFile(root), 'utf8'))
    const row = onDisk.profiles.find((p) => p.id === created.id)
    assert.equal(row.template, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeProfile：provider/model 须为非空字符串', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profiles-types-'))
  try {
    await ensureProfilesStore(root)
    await assert.rejects(
      () => materializeProfile('profile_default', { name: 'x', provider: {}, model: 'm', dshPreset: null }, root),
      (err) => err.message === '需要选择服务商与模型',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('实体化：序号递增、删后不复用、同名可并存、模板仍空白', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profiles-'))
  try {
    await ensureProfilesStore(root)
    const a = await materializeProfile(
      'profile_default',
      {
        name: '通用助手',
        provider: 'deepseek',
        model: 'deepseek-chat',
        dshPreset: 'DeepSeek',
      },
      root,
    )
    assert.equal(a.id, 'profile_default-1')
    assert.equal(a.builtin, false)
    assert.equal(a.template, false)

    const b = await materializeProfile(
      'profile_default',
      {
        name: '通用助手',
        provider: 'openai',
        model: 'gpt-4o',
        dshPreset: 'Default',
      },
      root,
    )
    assert.equal(b.id, 'profile_default-2')
    assert.equal(a.name, b.name)

    await deleteProfileForTest('profile_default-1', root)
    const c = await materializeProfile(
      'profile_default',
      {
        name: '又一次',
        provider: 'deepseek',
        model: 'deepseek-chat',
        dshPreset: null,
        personaAppend: '手动人设附加',
      },
      root,
    )
    assert.equal(c.id, 'profile_default-3')
    assert.equal(c.config.personaAppend, '手动人设附加')

    const tpl = await getProfile('profile_default', root)
    assert.equal(tpl.config.provider, null)
    assert.equal(tpl.config.model, null)
    assert.equal(tpl.config.dshPreset, null)

    const onDisk = JSON.parse(readFileSync(profilesFile(root), 'utf8'))
    assert.equal(onDisk.templates.profile_default.nextSeq, 4)
    const all = await listProfiles(root)
    const templates = all.filter((p) => p.template)
    assert.equal(templates.length, 3)
    for (const t of templates) {
      assert.equal(t.config.provider, null)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
