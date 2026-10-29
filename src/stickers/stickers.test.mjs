import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  LIMITS,
  clearRecent,
  createPack,
  deletePack,
  deleteSticker,
  loadCatalog,
  pushRecent,
  renamePack,
  resolveSendTarget,
  saveSticker,
  searchStickers,
  takeLatestRecent,
  updateSticker,
} from './store.mjs'
import { createStickersTools } from './tools.mjs'
import { OPEN_TOOLS } from '../channels/telegram/owner-gate.mjs'

/** 最小合法 1×1 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-stickers-'))
}

async function writePng(dir, name = 'hi.png') {
  const path = join(dir, name)
  await writeFile(path, PNG_1X1)
  return path
}

test('catalog: default pack, save from path, dedupe by hash, search', async () => {
  const dir = await tempDir()
  try {
    const cat0 = await loadCatalog(dir)
    assert.ok(cat0.packs.some((p) => p.name === '默认'))
    const png = await writePng(dir)
    const { sticker, deduped } = await saveSticker({
      path: png,
      tags: ['开心', '打招呼'],
      aliases: ['hi', '你好'],
      emoji: '🙂',
      source: { channel: 'import', originalName: 'hi.png' },
    }, dir)
    assert.equal(deduped, false)
    assert.ok(sticker.id.startsWith('stk_'))
    assert.equal(sticker.tags.length, 2)
    assert.equal(sticker.width, 1)
    assert.equal(sticker.height, 1)
    assert.equal(createHash('sha256').update(PNG_1X1).digest('hex'), sticker.hash)

    const again = await saveSticker({ path: png, aliases: ['hello'] }, dir)
    assert.equal(again.deduped, true)
    assert.equal(again.sticker.id, sticker.id)
    assert.ok(again.sticker.aliases.includes('hello'))

    const hit = await searchStickers({ query: '开心 hi' }, dir)
    assert.equal(hit.count, 1)
    assert.equal(hit.stickers[0].id, sticker.id)

    const byTag = await searchStickers({ tag: '打招呼' }, dir)
    assert.equal(byTag.count, 1)

    const cat = await loadCatalog(dir)
    assert.equal(cat.stats.stickers, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveSendTarget: id preferred; alias/tag multi-hit returns candidates', async () => {
  const dir = await tempDir()
  try {
    const png = await writePng(dir)
    const a = await saveSticker({ path: png, aliases: ['wave'], tags: ['mood'] }, dir)
    // second sticker: same hash would dedupe in same pack — use other pack
    await createPack({ name: '其他' }, dir)
    const png2 = await writePng(dir, 'b.png')
    // identical bytes still dedupe only within pack; different pack allows same hash
    const b = await saveSticker({ path: png2, pack: '其他', aliases: ['wave'], tags: ['mood'] }, dir)
    assert.notEqual(a.sticker.id, b.sticker.id)

    const byId = await resolveSendTarget({ id: a.sticker.id }, dir)
    assert.equal(byId.ok, true)

    const ambAlias = await resolveSendTarget({ alias: 'wave' }, dir)
    assert.equal(ambAlias.ok, false)
    assert.equal(ambAlias.reason, 'ambiguous_alias')
    assert.ok(ambAlias.candidates.length >= 2)

    const ambTag = await resolveSendTarget({ tag: 'mood' }, dir)
    assert.equal(ambTag.ok, false)
    assert.equal(ambTag.reason, 'ambiguous_tag')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('packs: create rename delete cascades stickers', async () => {
  const dir = await tempDir()
  try {
    const { pack } = await createPack({ name: '节日' }, dir)
    const png = await writePng(dir)
    await saveSticker({ path: png, pack: pack.id, tags: ['春节'] }, dir)
    await renamePack(pack.id, { name: '节日表情' }, dir)
    const cat = await loadCatalog(dir)
    assert.ok(cat.packs.some((p) => p.name === '节日表情'))
    assert.equal(cat.stats.stickers, 1)
    const del = await deletePack(pack.id, dir)
    assert.equal(del.stickersRemoved, 1)
    assert.equal((await loadCatalog(dir)).stats.stickers, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('update and delete sticker; reject remote URL', async () => {
  const dir = await tempDir()
  try {
    const png = await writePng(dir)
    const { sticker } = await saveSticker({ path: png, tags: ['a'] }, dir)
    const upd = await updateSticker(sticker.id, { tags: ['b'], aliases: ['x'], emoji: '✨' }, dir)
    assert.deepEqual(upd.sticker.tags, ['b'])
    assert.deepEqual(upd.sticker.aliases, ['x'])
    await assert.rejects(
      () => saveSticker({ path: 'https://example.com/x.png' }, dir),
      /URL|远程/,
    )
    await deleteSticker(sticker.id, dir)
    assert.equal((await loadCatalog(dir)).stats.stickers, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recent buffer: push, take latest, clear', async () => {
  const dir = await tempDir()
  try {
    await pushRecent('sess1', { data: PNG_1X1, mediaType: 'image/png', channel: 'qq' }, dir)
    const latest = await takeLatestRecent('sess1', dir)
    assert.equal(latest.mediaType, 'image/png')
    assert.equal(latest.data.length, PNG_1X1.length)
    const saved = await saveSticker({
      data: latest.data,
      mediaType: latest.mediaType,
      originalName: latest.originalName,
      source: latest.source,
      tags: ['from-recent'],
    }, dir)
    assert.ok(saved.sticker.id)
    await clearRecent('sess1', dir)
    await assert.rejects(() => takeLatestRecent('sess1', dir), /没有最近/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tools register names; OPEN_TOOLS has search+send not save', async () => {
  const tools = createStickersTools({
    dir: await tempDir(),
    getAttachments: () => ({ saveImage: async () => ({ attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'x.png' }) }),
  })
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['sticker_save', 'sticker_search', 'sticker_send'])
  assert.ok(OPEN_TOOLS.has('sticker_search'))
  assert.ok(OPEN_TOOLS.has('sticker_send'))
  assert.equal(OPEN_TOOLS.has('sticker_save'), false)
  assert.ok(LIMITS.fileBytes >= 1024 * 1024)
})
