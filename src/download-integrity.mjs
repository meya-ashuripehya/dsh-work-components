/**
 * 下载校验辅助。不发起网络请求。
 * Node 官方包仍走 tools.mjs 里已有的 SHASUMS256 路径；这里给 uv 固定版本和通用摘要。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export function hashFile(file, algorithm) {
  return new Promise((ok, fail) => {
    const hash = createHash(algorithm)
    createReadStream(file)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => ok(hash.digest('hex')))
  })
}

/**
 * 解析 `sha256sum` 风格文本。单行纯十六进制，或 `<hex>  <文件名>`。
 * 给出文件名时必须对上，避免把别的资产的摘要拿来用。
 */
export function parseSha256Sum(text, assetName) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const wanted = assetName ? String(assetName).replace(/\\/g, '/').split('/').pop() : ''
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})(?:\s+\*?(\S+))?$/.exec(line)
    if (!match) continue
    const name = match[2] ? match[2].replace(/\\/g, '/').split('/').pop() : ''
    if (wanted && name && name !== wanted) continue
    if (wanted && !name && lines.length > 1) continue
    return match[1].toLowerCase()
  }
  throw new Error(wanted ? `校验文件中没有 ${wanted} 的 sha256` : '校验文件无法解析')
}

/** 把 GitHub releases/latest 的跳转目标收成具体 tag。拒绝仍指向 latest 的结果。 */
export function tagFromReleaseRedirect(location, repo = 'astral-sh/uv') {
  let url
  try { url = new URL(location) } catch {
    throw new Error('版本跳转地址无效')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error(`版本页必须在 https://github.com 上：${url.hostname || url.protocol}`)
  }
  const parts = url.pathname.split('/').filter(Boolean)
  // /astral-sh/uv/releases/tag/<tag>
  if (parts.length !== 5 || parts[0] !== repo.split('/')[0] || parts[1] !== repo.split('/')[1] || parts[2] !== 'releases' || parts[3] !== 'tag') {
    throw new Error(`无法从跳转地址解析发行标签：${url.pathname}`)
  }
  const tag = parts[4]
  if (!tag || tag === 'latest' || !/^[\w.+-]+$/.test(tag)) throw new Error(`发行标签不可用：${tag || '(空)'}`)
  return tag
}

export function uvReleaseUrls(tag, asset) {
  if (!/^[\w.+-]+$/.test(tag)) throw new Error(`发行标签不可用：${tag}`)
  if (!asset || asset.includes('/') || asset.includes('..')) throw new Error('uv 资源名无效')
  const base = `https://github.com/astral-sh/uv/releases/download/${tag}/`
  return {
    tag,
    asset,
    archiveUrl: base + asset,
    checksumUrl: base + asset + '.sha256',
  }
}
