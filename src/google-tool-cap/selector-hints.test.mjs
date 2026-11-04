import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectorPrompt } from '../chatroom/tool-selector.mjs'
import { matchScenes, annotateCatalog } from './scenes.mjs'

describe('selectorPrompt scene hints', () => {
  it('includes exclusivity hints and preferred tags for desktop-ui', () => {
    const scenes = matchScenes('点击桌面控件')
    const cat = [
      { name: 'mcp__windows__screenshot', description: 'OS screenshot' },
      { name: 'mcp__desktop__click', description: 'control click' },
    ]
    const { catalog, hints } = annotateCatalog(cat, scenes)
    const { system, user } = selectorPrompt('点击桌面控件', catalog, {
      current: ['mcp__windows__screenshot'],
      max: 3,
      hints,
    })
    assert.match(system, /specialized tools over overlapping generalists/i)
    assert.match(system, /desktop-ui|prefer mcp__desktop/i)
    assert.match(user, /mcp__desktop__click/)
    assert.match(user, /preferred for matched scene/)
  })
})
