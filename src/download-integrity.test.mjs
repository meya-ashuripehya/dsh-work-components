import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSha256Sum, tagFromReleaseRedirect, uvReleaseUrls } from './download-integrity.mjs'

test('parseSha256Sum accepts a bare hash and a named line', () => {
  const hex = 'a'.repeat(64)
  assert.equal(parseSha256Sum(hex + '\n', 'uv.zip'), hex)
  assert.equal(parseSha256Sum(`${hex}  uv-x86_64-pc-windows-msvc.zip\n`, 'uv-x86_64-pc-windows-msvc.zip'), hex)
})

test('parseSha256Sum rejects a hash for a different asset', () => {
  const hex = 'b'.repeat(64)
  assert.throws(() => parseSha256Sum(`${hex}  other.zip\n`, 'uv.zip'), /没有 uv.zip/)
})

test('latest redirect resolves to a concrete uv tag and asset urls', () => {
  const tag = tagFromReleaseRedirect('https://github.com/astral-sh/uv/releases/tag/0.5.11')
  assert.equal(tag, '0.5.11')
  const urls = uvReleaseUrls(tag, 'uv-x86_64-pc-windows-msvc.zip')
  assert.equal(urls.archiveUrl, 'https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-pc-windows-msvc.zip')
  assert.equal(urls.checksumUrl, urls.archiveUrl + '.sha256')
  assert.throws(() => tagFromReleaseRedirect('https://github.com/astral-sh/uv/releases/latest'), /发行标签/)
  assert.throws(() => tagFromReleaseRedirect('https://evil.example/uv/releases/tag/0.5.11'), /github.com/)
})
