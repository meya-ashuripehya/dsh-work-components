/**
 * 对照快照里的 SHA256SUMS，检查快照副本和工作区是否还是同一批字节。
 * 任一不一致就退出 1。快照生成之后工作区又改过，就不能把旧 tarball 当成这份工作区。
 *
 *   node scripts/snapshot-freshness.mjs <snapshot-dir>
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const snap = resolve(process.argv[2] || '')
if (!process.argv[2]) {
  console.error('usage: node scripts/snapshot-freshness.mjs <snapshot-dir>')
  process.exit(2)
}
const listPath = resolve(snap, 'SHA256SUMS')
if (!existsSync(listPath)) {
  console.error(`missing ${listPath}`)
  process.exit(1)
}

const mismatches = []
for (const line of readFileSync(listPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
  if (!match) {
    mismatches.push(`bad sum line: ${line}`)
    continue
  }
  const [, expected, rel] = match
  for (const [label, root] of [['snapshot', snap], ['workspace', repo]]) {
    const file = resolve(root, rel)
    if (!existsSync(file)) {
      mismatches.push(`${label} missing ${rel}`)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (actual !== expected) mismatches.push(`${label} drifted ${rel}`)
  }
}

if (mismatches.length) {
  console.error(`freshness failed ${mismatches.length}`)
  for (const row of mismatches.slice(0, 40)) console.error(row)
  process.exit(1)
}
console.log(`freshness ok ${readFileSync(listPath, 'utf8').split(/\r?\n/).filter(Boolean).length} files`)
