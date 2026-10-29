import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveCompanionInstruction,
  isCompanionCompactionEnabled,
  rewriteCompactionMessages,
  applyCompanionCompactionOptions,
  looksLikeOfficialCompactionInstruction,
} from './companion-compaction.mjs'
import { COMPANION_COMPACTION_INSTRUCTION } from './companion-instruction.mjs'

test('resolveCompanionInstruction uses built-in when empty', () => {
  assert.equal(resolveCompanionInstruction({}), COMPANION_COMPACTION_INSTRUCTION)
  assert.equal(resolveCompanionInstruction({ companionCompactionInstruction: '  ' }), COMPANION_COMPACTION_INSTRUCTION)
})

test('custom instruction from getter wins when non-empty', () => {
  assert.equal(resolveCompanionInstruction({ companionCompactionInstruction: 'CUSTOM' }), 'CUSTOM')
})

test('isCompanionCompactionEnabled defaults on', () => {
  assert.equal(isCompanionCompactionEnabled({}), true)
  assert.equal(isCompanionCompactionEnabled({ companionCompactionEnabled: true }), true)
  assert.equal(isCompanionCompactionEnabled({ companionCompactionEnabled: false }), false)
})

test('rewriteCompactionMessages replaces last user only', () => {
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'old' }] },
  ]
  const next = rewriteCompactionMessages(msgs, 'NEW')
  assert.equal(msgs[1].content[0].text, 'old')
  assert.equal(next[1].content[0].text, 'NEW')
  assert.equal(next[0].role, 'system')
})

test('looksLikeOfficialCompactionInstruction', () => {
  assert.equal(looksLikeOfficialCompactionInstruction('AI coding assistant'), true)
  assert.equal(looksLikeOfficialCompactionInstruction('## Primary Request and Intent'), true)
  assert.equal(looksLikeOfficialCompactionInstruction('hello'), false)
})

test('applyCompanionCompactionOptions only for compaction purpose', () => {
  const opts = {
    purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'AI coding assistant ## Primary Request and Intent' }] }],
  }
  const next = applyCompanionCompactionOptions(opts, 'COMPANION')
  assert.notEqual(next, opts)
  assert.equal(next.messages[0].content[0].text, 'COMPANION')
})

test('applyCompanionCompactionOptions still replaces when last user lacks official markers', () => {
  const opts = {
    purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'random' }] }],
  }
  const next = applyCompanionCompactionOptions(opts, 'COMPANION')
  assert.equal(next.messages[0].content[0].text, 'COMPANION')
})

test('applyCompanionCompactionOptions skips non-compaction without markers', () => {
  const opts = {
    purpose: 'chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  assert.equal(applyCompanionCompactionOptions(opts, 'X'), opts)
})

test('applyCompanionCompactionOptions replaces on official markers without purpose', () => {
  const opts = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'You are now acting as a compaction engine for this AI coding assistant.' }] }],
  }
  const next = applyCompanionCompactionOptions(opts, 'COMPANION')
  assert.equal(next.messages[0].content[0].text, 'COMPANION')
})
