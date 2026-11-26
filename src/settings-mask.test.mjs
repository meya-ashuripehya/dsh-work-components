import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SECRET_MASK, maskSecretFields } from './settings-mask.mjs'

test('settings JSON does not echo a saved secret', () => {
  const out = maskSecretFields({
    gmailAppPassword: 'app-password-should-not-leak',
    githubToken: '',
    desktopEnabled: false,
  }, ['gmailAppPassword', 'githubToken'])
  assert.equal(out.gmailAppPassword, SECRET_MASK)
  assert.equal(out.githubToken, '')
  assert.equal(out.desktopEnabled, false)
  assert.equal(JSON.stringify(out).includes('app-password-should-not-leak'), false)
})

test('the settings route uses the mask helper', () => {
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
  assert.match(source, /export function maskSecrets\(value\) \{\s*return maskSecretFields\(value, SECRET_KEYS\)/)
  assert.match(source, /maskSecrets\(current\)/)
})
