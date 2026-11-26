/**
 * 把 git 已跟踪文件和清单里的未跟踪纳入项复制到仓库外的目录。
 * 不复制 node_modules、缓存、gitignored 的生成物，也不复制经纪人 exe。
 * 待确认文件存在时拒绝继续，避免把用途不明的文件悄悄丢掉。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { listWorktree } from './release-inventory.mjs'

const repo = resolve(import.meta.dirname, '..')
const destArg = process.argv[2]
if (!destArg) {
  console.error('usage: node scripts/make-release-snapshot.mjs <dest-outside-repo>')
  process.exit(2)
}
const dest = resolve(destArg)

function insideRepo(path) {
  const rel = relative(repo, path)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

if (insideRepo(dest)) {
  console.error(`拒绝把快照写进仓库内：${dest}`)
  process.exit(2)
}

const listed = listWorktree(repo)
if (listed.pending.length) {
  console.error('存在待确认文件，未创建快照')
  for (const row of listed.pending) console.error(`${row.path}\t${row.reason}`)
  process.exit(2)
}

function gitFiles() {
  const run = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(run.stderr || 'git ls-files failed')
  return run.stdout.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'))
}

const tracked = new Set(gitFiles())
const files = new Set(tracked)
for (const row of listed.include) {
  const path = row.path.replace(/\\/g, '/')
  if (path.endsWith('/')) continue
  files.add(path)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

const skipped = []
const sums = []
let copied = 0
for (const rel of files) {
  if (rel.split('/').includes('node_modules')) {
    skipped.push(`${rel}\tnode_modules`)
    continue
  }
  if (rel.endsWith('DSHDesktopBroker.exe') || rel.includes('/__pycache__/') || rel.includes('/.eclipse/')) {
    skipped.push(`${rel}\tdenied`)
    continue
  }
  const from = resolve(repo, rel)
  let info
  try { info = statSync(from) } catch {
    skipped.push(`${rel}\tmissing`)
    continue
  }
  if (!info.isFile()) {
    skipped.push(`${rel}\tnot-a-file`)
    continue
  }
  if (info.size > 40 * 1024 * 1024) {
    console.error(`拒绝复制超过 40 MiB 的文件：${rel} (${info.size})`)
    process.exit(2)
  }
  const to = resolve(dest, rel)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  sums.push(`${createHash('sha256').update(readFileSync(from)).digest('hex')}  ${rel}`)
  copied++
}

const note = [
  `source=${repo}`,
  `copied=${copied}`,
  `skipped=${skipped.length}`,
  'lib/client.js is copied as tracked handwritten source.',
  'Other lib outputs are rebuilt in this tree; gitignored generated files were not copied.',
  'The desktop broker exe was not copied.',
  '',
  '# skipped',
  ...skipped,
  '',
  '# excluded',
  ...listed.exclude.map((row) => `${row.path}\t${row.reason}`),
  '',
].join('\n')
writeFileSync(resolve(dest, 'SNAPSHOT.txt'), note)
writeFileSync(resolve(dest, 'SHA256SUMS'), sums.sort().join('\n') + '\n')
console.log(`snapshot ${dest} files=${copied} skipped=${skipped.length}`)
