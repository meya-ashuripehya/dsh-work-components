import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browse, deleteCategory, deleteNote, getNote, loadTree, notesFile, saveCategory, saveNote, search } from './store.mjs'
import { createNotesTools } from './tools.mjs'
import { createNotesFeature } from './index.mjs'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-notes-'))
}

async function seed(dir) {
  const { category: knowledge } = await saveCategory({ name: '知识', description: '事实与概念' }, dir)
  const { category: math } = await saveCategory({ name: '数学', parentId: knowledge.id }, dir)
  const { category: skill } = await saveCategory({ name: '技巧' }, dir)
  const { note } = await saveNote({ categoryId: math.id, title: '等比数列求和', content: '- 公比 q≠1 时 S=a1(1-q^n)/(1-q)\n- q=1 时 S=n·a1', tags: ['数列'] }, dir)
  return { knowledge, math, skill, note }
}

test('three levels: browse level by level with bounded summaries', async () => {
  const dir = await tempDir()
  try {
    const { knowledge, math, note } = await seed(dir)
    const l1 = await browse('', {}, dir)
    assert.equal(l1.level, 1)
    assert.deepEqual(l1.categories.map((c) => c.name), ['知识', '技巧'])
    assert.equal(l1.categories[0].notes, 1)
    assert.equal(l1.categories[0].subcategories, 1)
    const l2 = await browse(knowledge.id, {}, dir)
    assert.equal(l2.level, 2)
    assert.equal(l2.categories[0].path, '知识 › 数学')
    const l3 = await browse(math.id, {}, dir)
    assert.equal(l3.level, 3)
    assert.equal(l3.notes[0].id, note.id)
    assert.equal('content' in l3.notes[0], false)
    assert.ok(l3.notes[0].summary.length <= 81)
    const full = await getNote(note.id, dir)
    assert.match(full.content, /公比/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hierarchy rules: no third category level, notes only under level 2, no duplicates', async () => {
  const dir = await tempDir()
  try {
    const { knowledge, math } = await seed(dir)
    await assert.rejects(saveCategory({ name: '代数', parentId: math.id }, dir), /最多两级/)
    await assert.rejects(saveNote({ categoryId: knowledge.id, title: 'x', content: 'y' }, dir), /第二级/)
    await assert.rejects(saveNote({ categoryId: math.id, title: '等比数列求和', content: 'dup' }, dir), /同名笔记/)
    await assert.rejects(saveCategory({ name: '数学', parentId: knowledge.id }, dir), /同名类别/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('update, append, search and delete a note', async () => {
  const dir = await tempDir()
  try {
    const { math, note } = await seed(dir)
    const { note: updated } = await saveNote({ id: note.id, append: '- 注意 q 为负数时同样适用' }, dir)
    assert.match(updated.content, /负数/)
    assert.equal(updated.createdAt, note.createdAt)
    const hit = await search('等比 求和', {}, dir)
    assert.equal(hit.total, 1)
    assert.equal((await search('', { tag: '数列' }, dir)).total, 1)
    assert.equal((await search('不存在的词', {}, dir)).total, 0)
    assert.equal((await search('数学', {}, dir)).categories[0].id, math.id)
    await deleteNote(note.id, dir)
    assert.equal((await loadTree(dir)).notes.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('deleting a non-empty category needs confirm; empty one deletes directly', async () => {
  const dir = await tempDir()
  try {
    const { knowledge, skill } = await seed(dir)
    const first = await deleteCategory(knowledge.id, {}, dir)
    assert.equal(first.deleted, false)
    assert.equal(first.needsConfirm, true)
    assert.equal(first.notes, 1)
    assert.equal(first.subcategories, 1)
    assert.match(first.message, /confirm: true/)
    assert.equal((await loadTree(dir)).categories.length, 3)
    const second = await deleteCategory(knowledge.id, { confirm: true }, dir)
    assert.equal(second.deleted, true)
    const tree = await loadTree(dir)
    assert.deepEqual(tree.categories.map((c) => c.name), ['技巧'])
    assert.equal(tree.notes.length, 0)
    assert.equal((await deleteCategory(skill.id, {}, dir)).deleted, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('store is atomic JSON with no leftover temp files', async () => {
  const dir = await tempDir()
  try {
    await seed(dir)
    const data = JSON.parse(await readFile(notesFile(dir), 'utf8'))
    assert.equal(data.version, 1)
    assert.equal(data.categories.length, 3)
    assert.deepEqual((await readdir(join(dir, 'notes'))).filter((f) => f.endsWith('.tmp')), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('tools: names, schemas build, category delete confirm flow', async () => {
  const dir = await tempDir()
  try {
    const tools = createNotesTools({ dir })
    const names = tools.map((t) => t.name)
    assert.deepEqual(names, ['note_browse', 'note_search', 'note_get', 'note_save', 'note_delete', 'note_category_save', 'note_category_delete'])
    const by = Object.fromEntries(tools.map((t) => [t.name, t]))
    const { category: l1 } = await by.note_category_save.execute({ name: '规则' })
    const { category: l2 } = await by.note_category_save.execute({ name: '代码风格', parentId: l1.id })
    const { note } = await by.note_save.execute({ categoryId: l2.id, title: '提交信息', content: '使用中文', tags: ['git'] })
    const browsed = await by.note_browse.execute({ categoryId: l2.id })
    assert.equal(browsed.notes[0].id, note.id)
    const refused = await by.note_category_delete.execute({ id: l1.id })
    assert.equal(refused.needsConfirm, true)
    const done = await by.note_category_delete.execute({ id: l1.id, confirm: true })
    assert.equal(done.deleted, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('feature is off by default and mounts tools only when enabled', async () => {
  let cfg = {}
  const registered = []
  let disposed = 0
  const ctx = {
    logger: { warn() {} },
    plugin(def) {
      def.apply({ inject(_deps, fn) { fn({ tools: { register(t) { registered.push(t.name) } } }) } })
      return { dispose() { disposed++ } }
    },
  }
  const feature = createNotesFeature(ctx, () => cfg)
  await feature.sync()
  assert.equal(feature.state().status, 'off')
  assert.equal(registered.length, 0)
  cfg = { notesEnabled: true }
  await feature.sync()
  assert.equal(feature.state().status, 'on')
  assert.ok(registered.includes('note_save'))
  cfg = { notesEnabled: false }
  await feature.sync()
  assert.equal(feature.state().mounted, false)
  assert.equal(disposed, 1)
  await feature.dispose()
})
