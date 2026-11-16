import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchScenes,
  annotateCatalog,
  lexicalSceneMatch,
  mcpServerOf,
  suiteNamesForScenes,
  SUITE_CAP,
} from './scenes.mjs'

describe('scenes routing', () => {
  it('mcpServerOf parses mcp__desktop__click', () => {
    assert.equal(mcpServerOf('mcp__desktop__click'), 'desktop')
    assert.equal(mcpServerOf('bash'), '')
    assert.equal(mcpServerOf('mcp__figma_desktop__click'), 'figma_desktop')
    assert.equal(mcpServerOf('mcp__chrome-devtools__evaluate'), 'chrome-devtools')
    assert.equal(mcpServerOf('mcp__Figma__get'), 'figma')
  })

  it('desktop-ui query matches desktop scene and demotes windows', () => {
    const scenes = matchScenes('帮我点击桌面上的按钮并截图')
    assert.ok(scenes.some((s) => s.id === 'desktop-ui'))
    const cat = [
      { name: 'mcp__windows__screenshot', description: '截图' },
      { name: 'mcp__desktop__click', description: '点击控件' },
      { name: 'mcp__windows__powershell', description: '跑 PowerShell' },
      { name: 'bash', description: 'shell' },
    ]
    const { catalog, hints } = annotateCatalog(cat, scenes)
    assert.ok(hints.length >= 1)
    assert.equal(catalog[0].name, 'mcp__desktop__click')
    assert.match(catalog[0].description, /preferred/)
    const winShot = catalog.find((t) => t.name === 'mcp__windows__screenshot')
    assert.match(winShot.description, /generalist|overlapping/i)
  })

  it('lexicalSceneMatch prefers desktop over windows for click query', () => {
    const scenes = matchScenes('click desktop button')
    const cat = [
      { name: 'mcp__windows__click' },
      { name: 'mcp__desktop__click' },
      { name: 'mcp__windows__powershell' },
    ]
    const names = lexicalSceneMatch('click desktop', cat, scenes, 3)
    assert.ok(names.includes('mcp__desktop__click'))
    assert.ok(!names.includes('mcp__windows__click'), 'demoted overlapping windows click')
  })

  it('windows-os query does not demote windows', () => {
    const scenes = matchScenes('用 PowerShell 改注册表')
    assert.ok(scenes.some((s) => s.id === 'windows-os'))
    const cat = [
      { name: 'mcp__windows__powershell', description: 'ps' },
      { name: 'mcp__desktop__click', description: 'click' },
    ]
    const { catalog } = annotateCatalog(cat, scenes)
    const win = catalog.find((t) => t.name === 'mcp__windows__powershell')
    assert.match(win.description, /preferred/)
  })

  it('suiteNamesForScenes returns full chrome preferServers suite for browser chrome', () => {
    const scenes = matchScenes('browser chrome')
    assert.ok(scenes.some((s) => s.id === 'browser'))
    const cat = [
      { name: 'bash', description: 'shell' },
      { name: 'mcp__windows__powershell', description: 'ps' },
      { name: 'mcp__chrome__navigate', description: 'nav' },
      { name: 'mcp__chrome__click', description: 'click' },
      { name: 'mcp__chrome__screenshot', description: 'shot' },
      { name: 'mcp__chrome__type', description: 'type' },
      { name: 'mcp__chrome-devtools__evaluate', description: 'eval' },
      { name: 'mcp__desktop__click', description: 'desk' },
    ]
    const suite = suiteNamesForScenes(cat, scenes)
    assert.deepEqual(suite, [
      'mcp__chrome-devtools__evaluate',
      'mcp__chrome__click',
      'mcp__chrome__navigate',
      'mcp__chrome__screenshot',
      'mcp__chrome__type',
    ])
    const lex = lexicalSceneMatch('browser chrome', cat, scenes, 3)
    assert.ok(lex.length <= 3)
    assert.ok(suite.length > lex.length, 'suite expands beyond lexical top-3')
    assert.equal(suite.includes('mcp__windows__powershell'), false)
    assert.equal(suite.includes('bash'), false)
  })

  it('suiteNamesForScenes respects SUITE_CAP', () => {
    const scenes = matchScenes('browser chrome')
    const cat = []
    for (let i = 0; i < SUITE_CAP + 10; i++) {
      cat.push({ name: 'mcp__chrome__t' + String(i).padStart(3, '0') })
    }
    const suite = suiteNamesForScenes(cat, scenes)
    assert.equal(suite.length, SUITE_CAP)
    const capped = suiteNamesForScenes(cat, scenes, 5)
    assert.equal(capped.length, 5)
  })

  it('suiteNamesForScenes empty when no scene match', () => {
    const scenes = matchScenes('something unrelated xyz')
    const cat = [{ name: 'mcp__chrome__navigate' }]
    assert.deepEqual(suiteNamesForScenes(cat, scenes), [])
  })
})
