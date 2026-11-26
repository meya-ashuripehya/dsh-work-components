import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { appendTaggedMessage, presetMemoryPath } from './cross-session-memory-store.mjs'

// The real host and QQ/Telegram runtimes are separate esbuild outputs.
// Importing only source modules hides split-singleton bugs, so build two copies.
for (const platform of ['telegram', 'qq']) {
test(`${platform}: separately bundled channel honors the live host memory switch`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csm-bundle-switch-'))
  const root = resolve(import.meta.dirname, '../..')
  const source = name => JSON.stringify(join(root, 'src/channels', name))
  let host
  try {
    for (const name of ['host', 'channel']) {
      await build({ stdin: { contents: `
        export { setPersonMemoryProvider, getPersonMemoryProvider, installPersonMemoryInject } from ${source('person-memory-inject.mjs')};
        export { setMemoryWriteRuntime, getMemoryWriteRuntime, injectForChannel, writeAssistantChannelMessage } from ${source('cross-session-memory-write.mjs')};
      `, resolveDir: root, sourcefile: `${name}.mjs` }, outfile: join(dir, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
    }
    host = await import(pathToFileURL(join(dir, 'host.mjs')))
    const channel = await import(pathToFileURL(join(dir, 'channel.mjs')))
    let cfg = { crossSessionMemoryEnabled: false, chatroomSeats: [{ preset: 'lingsnow', crossSessionMemoryEnabled: true }] }
    const home = join(dir, 'home')
    await appendTaggedMessage('lingsnow', { role: 'user', text: 'SYNTHETIC OTHER SESSION MEMORY', speaker: 'test', scene: { sessionId: 'other', channel: platform, peerId: 'test' }, home })
    host.setMemoryWriteRuntime({ getConfig: () => cfg, home, compacting: new Set() })
    host.setPersonMemoryProvider(() => ({ enabled: cfg.crossSessionMemoryEnabled, config: cfg, learnedFile: join(dir, 'aliases.json') }))
    assert.equal(typeof channel.getPersonMemoryProvider(), 'function', `${platform} bundle must use the host provider, not a fresh null singleton`)
    assert.equal(channel.getMemoryWriteRuntime(), host.getMemoryWriteRuntime())
    class Bridge { async handleQueuedMessage(event) { return event } }
    channel.installPersonMemoryInject(Bridge)
    const bridge = new Bridge()
    const plain = { channel: platform, conversation: { id: 'test', type: 'dm' }, sender: { id: 'test' }, message: { id: 'test', content: [{ type: 'text', text: 'new user message' }] } }
    assert.equal(channel.injectForChannel({ preset: 'lingsnow', sessionId: 'here' }), '')
    assert.equal((await bridge.handleQueuedMessage(plain)).__dshInboundPrefix, undefined)
    const before = await readFile(presetMemoryPath('lingsnow', home), 'utf8')
    assert.equal(await channel.writeAssistantChannelMessage({ route: { preset: 'lingsnow' }, sessionId: 'here', channelId: platform, conversationId: 'test' }, 'must not write while disabled'), null)
    assert.equal(await readFile(presetMemoryPath('lingsnow', home), 'utf8'), before)
    cfg = { ...cfg, crossSessionMemoryEnabled: true }
    if (platform === 'telegram') {
      const enriched = await bridge.handleQueuedMessage(plain)
      assert.match(enriched.__dshInboundPrefix, /\[person-memory\]/)
    }
    assert.match(channel.injectForChannel({ preset: 'lingsnow', sessionId: 'here' }), /SYNTHETIC OTHER SESSION MEMORY/)
    cfg = { ...cfg, crossSessionMemoryEnabled: false }
    assert.equal(channel.injectForChannel({ preset: 'lingsnow', sessionId: 'here' }), '')
    for (const type of ['dm', 'group']) {
      const disabled = await bridge.handleQueuedMessage({ ...plain, conversation: { ...plain.conversation, type } })
      assert.equal(disabled.__dshInboundPrefix, undefined, `${platform} ${type}: no person summary or memory tail while disabled`)
    }
    cfg = { ...cfg, crossSessionMemoryEnabled: true, crossSessionMemory: { enabled: false } }
    assert.equal(channel.injectForChannel({ preset: 'lingsnow', sessionId: 'here' }), '')
    assert.equal((await bridge.handleQueuedMessage(plain)).__dshInboundPrefix, undefined)
    const queued = { ...plain, __dshInboundPrefix: '[cross-session-memory tail · other sessions]\nSTALE QUEUED MEMORY' }
    assert.equal((await bridge.handleQueuedMessage(queued)).__dshInboundPrefix, undefined)
    assert.match(queued.__dshInboundPrefix, /STALE/, 'do not mutate the queued source event')
    host.setPersonMemoryProvider(null)
    host.setMemoryWriteRuntime(null)
    assert.equal(channel.injectForChannel({ preset: 'lingsnow', sessionId: 'here' }), '')
    assert.equal((await bridge.handleQueuedMessage(plain)).__dshInboundPrefix, undefined)
  } finally {
    host?.setPersonMemoryProvider(null)
    host?.setMemoryWriteRuntime(null)
    await rm(dir, { recursive: true, force: true })
  }
})

}
