/**
 * 自更新逻辑单测：每日一次、忽略版本、semver / git 比较辅助。
 * 运行：node scripts/test-update.mjs
 */
import assert from 'node:assert/strict'
import {
  compareSemver,
  localDateKey,
  shouldAutoCheck,
  shouldPromptUpdate,
} from '../src/updater.mjs'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log('ok:', name) }
  catch (e) { console.error('FAIL:', name, e.message); process.exitCode = 1 }
}

ok('localDateKey shape', () => {
  const k = localDateKey(new Date('2026-10-09T12:00:00+08:00'))
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/)
})

ok('shouldAutoCheck: empty state', () => {
  assert.equal(shouldAutoCheck({ lastCheckDate: null }, '2026-10-09'), true)
  assert.equal(shouldAutoCheck({}, '2026-10-09'), true)
})

ok('shouldAutoCheck: always runs (every DSH start)', () => {
  assert.equal(shouldAutoCheck({ lastCheckDate: '2026-10-09' }, '2026-10-09'), true)
  assert.equal(shouldAutoCheck({ lastCheckDate: '2026-10-08' }, '2026-10-09'), true)
})

ok('shouldPromptUpdate: no update', () => {
  assert.equal(shouldPromptUpdate({ updateAvailable: false, latestVersion: '1.0.0' }, {}), false)
})

ok('shouldPromptUpdate: prompts when newer', () => {
  assert.equal(shouldPromptUpdate({ updateAvailable: true, latestVersion: '0.3.1' }, { ignoredVersion: null }), true)
})

ok('shouldPromptUpdate: respects ignore', () => {
  assert.equal(shouldPromptUpdate({ updateAvailable: true, latestVersion: '0.3.1' }, { ignoredVersion: '0.3.1' }), false)
})

ok('shouldPromptUpdate: newer than ignored still prompts', () => {
  assert.equal(shouldPromptUpdate({ updateAvailable: true, latestVersion: '0.3.2' }, { ignoredVersion: '0.3.1' }), true)
})

ok('compareSemver basic', () => {
  assert.equal(compareSemver('0.2.2', '0.3.0'), -1)
  assert.equal(compareSemver('0.3.0', '0.2.2'), 1)
  assert.equal(compareSemver('0.3.0', '0.3.0'), 0)
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1') !== 0, true) // unequal pre-release handling
})

ok('compareSemver npm vs git-local', () => {
  assert.ok(compareSemver('0.2.2', '0.3.0') < 0)
  assert.ok(compareSemver('0.3.0', '0.2.2') > 0)
})

// Lightweight git/npm compare shape tests using pure helpers already covered;
// detectInstallKind / findProfileBinding need a real tree — smoke below if plugin root available.


ok('git compare shape: behind means update', () => {
  // Mirrors gitCompareToOriginMain's updateAvailable: behind > 0
  const behind = 3, ahead = 0
  assert.equal(behind > 0, true)
  assert.equal(shouldPromptUpdate({ updateAvailable: behind > 0, latestVersion: 'abc1234' }, { ignoredVersion: 'old' }), true)
  assert.equal(shouldPromptUpdate({ updateAvailable: behind > 0, latestVersion: 'abc1234' }, { ignoredVersion: 'abc1234' }), false)
})

ok('npm compare: current ahead of registry is not an update', () => {
  assert.ok(compareSemver('0.3.0', '0.2.2') > 0)
  const updateAvailable = compareSemver('0.3.0', '0.2.2') < 0
  assert.equal(updateAvailable, false)
})

ok('npm compare: current behind registry is an update', () => {
  assert.equal(compareSemver('0.2.1', '0.2.2') < 0, true)
})

console.log(`update tests: ${passed} passed`)
if (process.exitCode) process.exit(process.exitCode)
