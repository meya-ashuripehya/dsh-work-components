import test from 'node:test'
import assert from 'node:assert/strict'
import { roomRules } from './transcript.mjs'

const seat = { id: 'claude', name: 'Claude', enabled: true }
const seats = [seat]

test('roomRules omits Minecraft lines without mcInfo', () => {
  const text = roomRules({ seat, seats, userName: 'Shiro' })
  assert.doesNotMatch(text, /Minecraft seat/)
})

test('roomRules injects mcInfo lines when present', () => {
  const text = roomRules({
    seat,
    seats,
    userName: 'Shiro',
    mcInfo: { lines: ['- Minecraft seat: you have NPC code "claude". Status: connected. last_error: none.'] },
  })
  assert.match(text, /Minecraft seat: you have NPC code "claude"/)
  assert.match(text, /Status: connected/)
})
