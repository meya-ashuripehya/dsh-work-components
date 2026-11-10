import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { exactGroupMatch, labelsFromRegistration, declarationRoom, normalizeExactKey } from './groups.mjs'
import { VERTEX_FUNCTION_DECLARATIONS_CAP } from './expose.mjs'

const tool = (name, extra = {}) => ({ name, description: name, ...extra })

describe('exact group match', () => {
  const catalog = [
    tool('mcp__figma__figjam_auto_arrange'),
    tool('mcp__figma__get_design_context'),
    tool('mcp__figma_desktop__click'),
    tool('mcp__chrome-devtools__evaluate'),
    tool('mcp__chrome__navigate'),
    tool('mcp__notes__page'),
    tool('bash'),
  ]

  it('matches Figma / fIgMa and the namespace spelling, not a substring', () => {
    for (const query of ['Figma', 'fIgMa', '  figma  ', 'mcp__FIGMA', 'mcp__figma__']) {
      const hit = exactGroupMatch(query, catalog)
      assert.equal(hit?.server, 'figma')
      assert.deepEqual(hit.tools, ['mcp__figma__figjam_auto_arrange', 'mcp__figma__get_design_context'])
    }
    assert.equal(exactGroupMatch('fig', catalog), null)
    assert.equal(exactGroupMatch('figjam', catalog), null)
    assert.equal(exactGroupMatch('figma desktop', catalog), null)
    assert.equal(normalizeExactKey('  Figma  '), 'figma')
  })

  it('keeps underscore and hyphen servers separate', () => {
    const under = exactGroupMatch('figma_desktop', catalog)
    assert.deepEqual(under.tools, ['mcp__figma_desktop__click'])
    const hyphen = exactGroupMatch('Chrome-DevTools', catalog)
    assert.deepEqual(hyphen.tools, ['mcp__chrome-devtools__evaluate'])
    assert.ok(!hyphen.tools.includes('mcp__chrome__navigate'))
  })

  it('uses registration display names and does not invent aliases', () => {
    const labels = labelsFromRegistration([
      { id: 'office', serverName: 'officemcp', label: 'Office', meta: { title: 'Office' } },
      { id: 'figma', label: 'Figma' },
    ])
    assert.equal(labels.some((row) => row.server === 'officemcp' && row.names.includes('office')), true)
    assert.equal(labels.some((row) => row.server === 'figma'), false)
    const cat = [tool('mcp__officemcp__open', { serverTitle: 'Office' }), tool('mcp__officemcp__save'), tool('mcp__chrome__navigate')]
    const hit = exactGroupMatch('Office', cat, { labels })
    assert.deepEqual(hit.tools, ['mcp__officemcp__open', 'mcp__officemcp__save'])
    assert.equal(exactGroupMatch('设计稿', cat, { labels }), null)
    const disabled = exactGroupMatch('Figma', cat, { labels: labelsFromRegistration([{ id: 'figma', serverName: 'figma', label: 'Figma', title: 'Figma' }]) })
    assert.equal(disabled.matched, true)
    assert.deepEqual(disabled.tools, [])
  })

  it('permission callback removes tools without granting the rest of another group', () => {
    const hit = exactGroupMatch('figma', catalog, { allow: () => false })
    assert.deepEqual(hit.tools, [])
    assert.equal(hit.denied.length, 2)
    const other = exactGroupMatch('notes', catalog, { allow: (name) => name.startsWith('mcp__notes__') })
    assert.deepEqual(other.tools, ['mcp__notes__page'])
  })

  it('declaration room reserves non-MCP tools and find_tools', () => {
    const schemas = []
    for (let i = 0; i < 10; i++) schemas.push({ name: 'core_' + i })
    schemas.push({ name: 'find_tools' }, { name: 'core_0' })
    for (let i = 0; i < 600; i++) schemas.push({ name: 'mcp__figma__t' + i })
    const room = declarationRoom(schemas)
    assert.equal(room.cap, VERTEX_FUNCTION_DECLARATIONS_CAP)
    assert.equal(room.core, 10)
    assert.equal(room.reserved, 11)
    assert.equal(room.room, 501)
  })
})
