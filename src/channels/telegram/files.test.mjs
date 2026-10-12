import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TELEGRAM_FILE_MAX_BYTES,
  classifyPreview,
  fileRefsFromToolResult,
  installFileDelivery,
  loadLocalFile,
  mmFileBlock,
  openFilePreview,
  readStoredFile,
  registerFilePreview,
} from './files.mjs'

test('loadLocalFile reads a local file and rejects a URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-file-'))
  try {
    const path = join(dir, 'note.txt')
    writeFileSync(path, 'hello')
    const loaded = loadLocalFile(path)
    assert.equal(loaded.name, 'note.txt')
    assert.equal(loaded.bytes, 5)
    assert.equal(loaded.mimeType, 'text/plain')
    assert.equal(Buffer.from(loaded.data).toString(), 'hello')
    assert.throws(() => loadLocalFile('https://example.com/a.pdf'), /remote URLs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fileRefsFromToolResult reads presentation meta and file blocks', () => {
  const refs = fileRefsFromToolResult({
    data: {
      meta: { telegramFile: { attachmentId: 'a', name: 'report.pdf', bytes: 12 } },
      message: { content: [{ type: 'file', attachment: { attachmentId: 'b', name: 'raw.bin', bytes: 4 } }] },
    },
  })
  assert.deepEqual(refs.map((ref) => ref.attachmentId), ['a', 'b'])
  assert.equal(fileRefsFromToolResult({
    data: { meta: { telegramFile: { attachmentId: 'big', name: 'huge.zip', bytes: TELEGRAM_FILE_MAX_BYTES + 1 } } },
  }).length, 0)
})

test('deliver sends a stored file as a document', async () => {
  const sent = []
  class Router {
    constructor() {
      this.pendingFiles = new Map()
      this.attachCtx = {
        get(name) {
          if (name !== 'attachments') return undefined
          return {
            async *readFileStream() {
              yield new Uint8Array([1, 2, 3])
            },
          }
        },
      }
      this.options = { replyContexts: { getTurn: () => true }, logger: { warn() {} } }
    }
    collectToolResultImages() {}
    async deliverTurnImages() {}
    dispose() {}
  }
  assert.equal(installFileDelivery(Router), true)
  const router = new Router()
  router.collectToolResultImages({ id: 's1' }, {
    data: {
      turn: 2,
      meta: { telegramFile: { attachmentId: 'file-1', name: 'note.txt', bytes: 3 } },
    },
  })
  await router.deliverTurnImages('s1', 2, {
    adapter: { capabilities: { file: true }, send: async (_target, message) => { sent.push(message) } },
    target: { conversationId: '-100' },
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].parts[0].type, 'file')
  assert.equal(sent[0].parts[0].name, 'note.txt')
  assert.equal(sent[0].parts[0].mimeType, 'text/plain')
  assert.deepEqual([...sent[0].parts[0].localData], [1, 2, 3])
})

test('deliver reads a local path when the attachment store has no files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-file-path-'))
  try {
    const path = join(dir, 'report.pdf')
    writeFileSync(path, '%PDF')
    const sent = []
    class Router {
      constructor() {
        this.options = { replyContexts: { getTurn: () => true }, logger: { warn() {} } }
      }
      collectToolResultImages() {}
      async deliverTurnImages() {}
      dispose() {}
    }
    assert.equal(installFileDelivery(Router), true)
    const router = new Router()
    router.collectToolResultImages({ id: 's2' }, {
      data: {
        turn: 1,
        meta: { telegramFile: { name: 'report.pdf', bytes: 4, path } },
      },
    })
    await router.deliverTurnImages('s2', 1, {
      adapter: { send: async (_target, message) => { sent.push(message) } },
      target: { conversationId: '1' },
    })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].parts[0].mimeType, 'application/pdf')
    assert.equal(Buffer.from(sent[0].parts[0].localData).toString(), '%PDF')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mmFileBlock picks a card kind from the file type', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-file-card-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = dir
  try {
    assert.equal(classifyPreview('notes.txt'), 'text')
    assert.equal(classifyPreview('clip.mp4'), 'video')
    assert.equal(classifyPreview('sheet.xlsx'), 'sheet')
    const path = join(dir, 'notes.txt')
    writeFileSync(path, 'hello file')
    const id = registerFilePreview({ path, name: 'notes.txt', mimeType: 'text/plain', bytes: 10 })
    assert.equal(openFilePreview(id).size, 10)
    assert.equal(openFilePreview('nope'), null)
    const text = mmFileBlock({
      name: 'notes.txt', bytes: 10, mimeType: 'text/plain', previewKind: 'text', previewId: id, text: 'hello file',
    })
    assert.equal(text.type, 'mm')
    assert.equal(text.kind, 'document')
    assert.equal(text.file.previewKind, 'text')
    assert.equal(text.file.text, 'hello file')
    const video = mmFileBlock({
      name: 'clip.mp4', bytes: 4, mimeType: 'video/mp4', previewKind: 'video', previewId: id,
    })
    assert.equal(video.kind, 'video')
    const image = mmFileBlock({
      name: 'a.png', bytes: 4, mimeType: 'image/png', previewKind: 'image', previewId: id,
      image: { attachmentId: 'img', mediaType: 'image/png', bytes: 4, width: 8, height: 8, name: 'a.png' },
    })
    assert.equal(image.kind, 'image')
    assert.equal(image.asset.attachment.attachmentId, 'img')
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readStoredFile falls back to fileHostPath', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-file-host-'))
  try {
    const path = join(dir, 'a.bin')
    writeFileSync(path, Buffer.from([9, 8]))
    const data = await readStoredFile({
      readFileStream() { throw new Error('unsupported') },
      fileHostPath() { return path },
    }, { attachmentId: 'x', name: 'a.bin', bytes: 2 })
    assert.deepEqual([...data], [9, 8])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
