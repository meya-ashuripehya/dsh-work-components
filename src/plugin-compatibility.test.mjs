import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePluginCompatibility } from './plugin-compatibility.mjs'

const RUNTIME = '0.2.2-rc.5'
const manifest = {
  name: 'dsh-work-components',
  version: '0.4.4',
  engines: { node: '^22.19 || >=24', dsh: RUNTIME },
  peerDependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2', 'image-size': '^2.0.0' },
}

test('engines.dsh accepts only the pinned runtime and ignores peers', () => {
  assert.equal(evaluatePluginCompatibility(manifest, {}, RUNTIME), undefined)
  const older = evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2')
  assert.equal(older.requirements['engines.dsh'], RUNTIME)
  assert.equal(older.requirements['@deepseek-ai/dsh'], undefined)
})

test('a missing engines.dsh and peerDependencies field skips the gate instead of proving compatibility', () => {
  assert.equal(evaluatePluginCompatibility({ name: 'x', version: '1.0.0' }, {}, RUNTIME), undefined)
})

test('without engines.dsh, workspace peers follow the current runtime and other peers stay unmet', () => {
  const peersOnly = {
    name: 'dsh-work-components',
    version: '0.4.4',
    peerDependencies: { '@deepseek-ai/dsh': 'workspace:^', 'image-size': '^2.0.0' },
  }
  assert.equal(evaluatePluginCompatibility(peersOnly, {}, RUNTIME), undefined)
  assert.equal(evaluatePluginCompatibility(peersOnly, {}, '0.2.0-rc.2'), undefined)
  const pinned = {
    ...peersOnly,
    peerDependencies: { '@deepseek-ai/dsh': RUNTIME },
  }
  assert.ok(evaluatePluginCompatibility(pinned, {}, '0.2.0-rc.2'))
})

test('workspace: is not rewritten when it is written in engines.dsh', () => {
  const issue = evaluatePluginCompatibility({
    name: 'dsh-work-components',
    version: '0.4.4',
    engines: { dsh: 'workspace:*' },
  }, {}, RUNTIME)
  assert.equal(issue.requirements['engines.dsh'], 'workspace:*')
})

test('an older runtime is incompatible and an exemption is not treated as success', () => {
  const issue = evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2')
  assert.equal(issue.exempted, false)
  assert.equal(issue.requirements['engines.dsh'], RUNTIME)
  const exempted = evaluatePluginCompatibility(manifest, { 'dsh-work-components@0.4.4': ['0.2.0-rc.2'] }, '0.2.0-rc.2')
  assert.equal(exempted.exempted, true)
  assert.equal(exempted.requirements['engines.dsh'], RUNTIME, 'exemption does not remove the mismatch')
})

test('earlier 0.2 releases, including 0.2.1-rc.5, are not claimed by the 0.2.2-rc.5 pin', () => {
  for (const runtime of ['0.2.0', '0.2.0-rc.2', '0.2.1', '0.2.1-rc.5', '0.2.2-rc.4']) {
    const issue = evaluatePluginCompatibility(manifest, {}, runtime)
    assert.ok(issue, runtime)
    assert.equal(issue.exempted, false)
  }
})

test('package.json pins the tested runtime and client inject layers stay distinct', () => {
  const root = join(import.meta.dirname, '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.engines.dsh, RUNTIME)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh'], RUNTIME)
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh'].optional, true)
  assert.equal(evaluatePluginCompatibility(pkg, {}, RUNTIME), undefined)
  assert.ok(evaluatePluginCompatibility(pkg, {}, '0.2.0-rc.2'))
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const match = client.match(/var inject = (\[[^\]]+\])/)
  assert.ok(match, 'client service inject')
  assert.deepEqual(JSON.parse(match[1].replace(/'/g, '"')), ['slots', 'sessions', 'uiConversation'])
  const host = readFileSync(join(root, 'src', 'index.mjs'), 'utf8')
  assert.match(host, /export const inject = \['tools', 'agents', 'sessions', 'sessionController', 'schedule'\]/)
})
