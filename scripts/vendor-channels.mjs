// Telegram 通道的 @wsz987/channel-* 0.5.1 打补丁副本（vendor/wsz987/<pkg>/）。
//
//   npm run vendor:channels           从 node_modules 里的原版 0.5.1 + vendor/wsz987/patches/*.patch 重新生成 vendor 副本
//   node scripts/vendor-channels.mjs --check   只校验：vendor 副本 == 原版 + 补丁（npm run check 会调用；缺 node_modules 时跳过）
//
// 为什么 vendor：npm install 会把 node_modules 里的包恢复成原版，而 esbuild 构建时从 vendor/ 取这三个包
// （scripts/build.mjs 的 resolve 插件），所以补丁不依赖 postinstall / patch-package，也不会被重装冲掉。
// 发布包里不带 vendor/：lib/channel-telegram.mjs 已是打好补丁的自包含产物。
// 补丁按文件名顺序应用；只应用 .js 文件（.d.ts / .map 不进 vendor）。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const VENDOR = join(root, 'vendor', 'wsz987')
const PATCHES = join(VENDOR, 'patches')
export const CHANNEL_PACKAGES = ['channel-core', 'channel-harness', 'channel-telegram']
const VERSION = '0.5.1'
const CHECK = process.argv.includes('--check')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** Parse a git-style unified diff into [{ file, hunks: [{ oldStart, lines }] }]. */
function parsePatch(text) {
  const files = []
  let cur = null
  let hunk = null
  for (const line of text.split('\n')) {
    let m
    if ((m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line))) {
      cur = { file: m[2], hunks: [] }
      files.push(cur)
      hunk = null
      continue
    }
    // diff -ruN / plain unified: --- a/path  +++ b/path  (also --- /dev/null for new files)
    if ((m = /^--- (?:a\/(\S+)|\/dev\/null)/.exec(line))) {
      const file = m[1] || null
      cur = { file, hunks: [], _pending: true }
      hunk = null
      continue
    }
    if ((m = /^\+\+\+ b\/(\S+)/.exec(line))) {
      if (cur && cur._pending) { cur.file = m[1]; delete cur._pending; files.push(cur) }
      else { cur = { file: m[1], hunks: [] }; files.push(cur) }
      hunk = null
      continue
    }
    if (!cur || cur._pending) continue
    if ((m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line))) {
      hunk = { oldStart: Number(m[1]), lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    const tag = line[0]
    if (tag === ' ' || tag === '-' || tag === '+') hunk.lines.push([tag, line.slice(1)])
  }
  return files.filter((f) => f.file && f.hunks.length)
}

function applyHunks(source, hunks, label) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  let delta = 0
  for (const h of hunks) {
    const oldLines = h.lines.filter(([t]) => t !== '+').map(([, s]) => s)
    const newLines = h.lines.filter(([t]) => t !== '-').map(([, s]) => s)
    const want = h.oldStart - 1 + delta
    const matchAt = (at) => at >= 0 && oldLines.every((s, i) => lines[at + i] === s)
    let at = -1
    for (let off = 0; off < 200 && at < 0; off++) {
      if (matchAt(want + off)) at = want + off
      else if (off && matchAt(want - off)) at = want - off
    }
    if (at < 0) throw new Error(`patch hunk @@ -${h.oldStart} does not apply to ${label}`)
    lines.splice(at, oldLines.length, ...newLines)
    delta += newLines.length - oldLines.length
  }
  return lines.join(eol)
}

/** Build { relPath -> content } for one package: pristine node_modules copy + patches. */
export function buildVendorTree(pkg) {
  const src = join(root, 'node_modules', '@wsz987', pkg)
  const meta = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  if (meta.version !== VERSION) throw new Error(`node_modules/@wsz987/${pkg} is ${meta.version}, expected ${VERSION}`)
  const tree = new Map()
  for (const file of walk(join(src, 'lib'))) {
    if (!file.endsWith('.js')) continue
    tree.set(relative(src, file).split(sep).join('/'), readFileSync(file, 'utf8'))
  }
  tree.set('package.json', readFileSync(join(src, 'package.json'), 'utf8'))
  if (existsSync(join(src, 'LICENSE'))) tree.set('LICENSE', readFileSync(join(src, 'LICENSE'), 'utf8'))
  const prefix = `@wsz987__${pkg}@${VERSION}`
  // 基础补丁（<prefix>.patch，与 pnpm patch 同名）先应用，其余增量补丁（<prefix>+<名>.patch）按名称排序随后应用。
  const patches = readdirSync(PATCHES)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.patch'))
    .sort((a, b) => (a === `${prefix}.patch` ? -1 : b === `${prefix}.patch` ? 1 : a.localeCompare(b)))
  for (const name of patches) {
    for (const { file, hunks } of parsePatch(readFileSync(join(PATCHES, name), 'utf8').replace(/\r\n/g, '\n'))) {
      if (!file.endsWith('.js')) continue
      // 允许补丁新增 .js 文件（--- a/path 且原树没有时按空文件起算）。
      if (!tree.has(file)) tree.set(file, '')
      tree.set(file, applyHunks(tree.get(file), hunks, `${pkg}/${file} (${name})`))
    }
  }
  return { tree, patches }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('vendor-channels.mjs')) {
  const problems = []
  if (!existsSync(join(root, 'node_modules', '@wsz987'))) {
    if (CHECK) {
      console.log('vendor:channels check skipped (node_modules/@wsz987 not installed; run npm install)')
      process.exit(0)
    }
    console.error('node_modules/@wsz987 missing: run npm install first')
    process.exit(1)
  }
  for (const pkg of CHANNEL_PACKAGES) {
    const { tree, patches } = buildVendorTree(pkg)
    const dir = join(VENDOR, pkg)
    if (CHECK) {
      const have = existsSync(dir) ? new Set(walk(dir).map((f) => relative(dir, f).split(sep).join('/'))) : new Set()
      // 比较时忽略换行差异（Windows 上 git autocrlf 检出的 CRLF 也算一致）。
      for (const [rel, content] of tree) {
        const file = join(dir, rel)
        if (!existsSync(file)) problems.push(`vendor/wsz987/${pkg}/${rel} missing`)
        else if (readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) problems.push(`vendor/wsz987/${pkg}/${rel} differs from npm ${VERSION} + patches`)
        have.delete(rel)
      }
      for (const extra of have) problems.push(`vendor/wsz987/${pkg}/${extra} is not produced by npm ${VERSION} + patches`)
      continue
    }
    rmSync(dir, { recursive: true, force: true })
    for (const [rel, content] of tree) {
      const file = join(dir, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    console.log(`vendor/wsz987/${pkg}: ${tree.size} files (${patches.length ? patches.join(', ') : 'no patches'})`)
  }
  if (problems.length) {
    console.error('vendor:channels check failed:\n- ' + problems.join('\n- '))
    process.exit(1)
  }
  if (CHECK) console.log(`vendor:channels ok: ${CHANNEL_PACKAGES.join(' / ')} == npm ${VERSION} + patches`)
}
