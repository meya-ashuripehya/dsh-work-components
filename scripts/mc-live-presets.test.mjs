import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLivePresets } from './mc-live-presets.mjs'
import { createDshCatalog } from '../src/dsh-catalog.mjs'

test('isolated host can read configured persona without loading tools or exposing credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-presets-'))
  try {
    const path = join(root, 'profile.yml')
    writeFileSync(path, '- insert:\n  - name: "@deepseek-ai/dsh-agent-preset"\n    config:\n      id: deepseek\n      plugins:\n      - name: dsh-persona\n        config:\n          prefix: REAL-PERSONA\n      - name: secret-tool\n        config:\n          key: MUST-NOT-LEAVE\n          condition: !!js ignored\n')
    const presets = readLivePresets(path, ['deepseek'])
    const catalog = createDshCatalog({ agentPresets: presets })
    assert.equal(await catalog.presetPersona('deepseek'), 'REAL-PERSONA')
    assert.doesNotMatch(JSON.stringify(await presets.readDocument('deepseek')), /MUST-NOT-LEAVE|secret-tool/)
    assert.throws(() => readLivePresets(path, ['missing']), /预检失败/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
