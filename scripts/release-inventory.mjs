/**
 * 候选快照分类。排除项只是不进快照 / 不进发布提交建议，不删除工作区原件。
 * 未跟踪文件必须落到 include、exclude 或 pending，不能靠「未跟踪」本身丢弃。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export const EXCLUDE_PREFIXES = [
  'scripts/__pycache__/',
  'src/components/gamebot/minecraft-neoforge-bridge/.eclipse/',
  'docs/video-segmentation-samples/',
]
export const EXCLUDE_EXACT = new Set([
  'SAMPLING-TASK.md',
  'SAMPLING-SLIDERS-TASK.md',
  'VIDEO-SEGMENTATION-TASK.md',
  'VIDEO-SEGMENTATION-REVIEW.md',
])

const EXCLUDE_REASONS = [
  [/^(?:scripts\/__pycache__\/|.*\/__pycache__\/)/, 'Python 字节码缓存'],
  [/^\.eclipse\/|\/\.eclipse\//, 'IDE 本地配置'],
  [/^docs\/video-segmentation-samples\//, '分段实验的媒体缓存和样例视频，不是产品源码'],
  [/^(?:SAMPLING-TASK|SAMPLING-SLIDERS-TASK|VIDEO-SEGMENTATION-TASK|VIDEO-SEGMENTATION-REVIEW)\.md$/, '代理任务稿，不是产品源码或用户文档'],
  [/^tmp-/, '临时脚本或转储'],
  [/\.bak(?:-|$)/, '手工备份'],
]

export function classifyUntracked(rel) {
  const path = rel.replace(/\\/g, '/').replace(/\/$/, '/')
  for (const [pattern, reason] of EXCLUDE_REASONS) {
    if (pattern.test(path)) return { action: 'exclude', reason }
  }
  if (EXCLUDE_EXACT.has(path.replace(/\/$/, ''))) return { action: 'exclude', reason: '代理任务稿' }
  if (EXCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix))) return { action: 'exclude', reason: '缓存或本地工具目录' }
  if (path.startsWith('src/') || path.startsWith('scripts/') || path.startsWith('docs/') || path.startsWith('.github/')) {
    return { action: 'include', reason: '产品源码、测试、文档或工作流' }
  }
  if (/^(?:SECURITY|PRIVACY|CHANGELOG)\.md$/.test(path)) return { action: 'include', reason: '发布文档' }
  return { action: 'pending', reason: '无法从路径判断用途' }
}

export function listWorktree(cwd = resolve(import.meta.dirname, '..')) {
  const run = spawnSync('git', ['status', '--porcelain=v1', '-uall'], { cwd, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(run.stderr || 'git status failed')
  const include = []
  const exclude = []
  const pending = []
  for (const line of run.stdout.split(/\r?\n/).filter(Boolean)) {
    const status = line.slice(0, 2)
    const rel = line.slice(3).replace(/\\/g, '/')
    if (!status.includes('?')) {
      include.push({ path: rel, reason: '已跟踪的改动，属于当前功能集合' })
      continue
    }
    const decision = classifyUntracked(rel.endsWith('/') ? rel : rel)
    const bucket = decision.action === 'include' ? include : decision.action === 'exclude' ? exclude : pending
    bucket.push({ path: rel, reason: decision.reason })
  }
  return { include, exclude, pending }
}

function markdown(listed) {
  const section = (title, rows) => [
    `## ${title}`,
    '',
    '| 路径 | 理由 |',
    '| --- | --- |',
    ...rows.map((row) => `| \`${row.path.replace(/\|/g, '\\|')}\` | ${row.reason} |`),
    '',
  ]
  return [
    '# 候选发布清单',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '基线是当前工作区，不是仅公开 main。纳入项进入候选快照；排除项只不进快照和发布提交建议，不删除本地原件。',
    '`lib/client.js` 是手写源码，快照必须原样保留。其余 `lib/*.mjs` 由候选源码重新构建。',
    '',
    ...section('纳入', listed.include),
    ...section('排除', listed.exclude),
    ...section('待确认', listed.pending),
  ].join('\n')
}

if (process.argv[1] && process.argv[1].endsWith('release-inventory.mjs')) {
  const listed = listWorktree()
  const out = process.argv.indexOf('--markdown')
  if (out >= 0) {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const file = process.argv[out + 1]
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, markdown(listed))
    console.log(`wrote ${file} include=${listed.include.length} exclude=${listed.exclude.length} pending=${listed.pending.length}`)
  } else {
    console.log(JSON.stringify({
      include: listed.include.length,
      exclude: listed.exclude.length,
      pending: listed.pending.length,
      pendingPaths: listed.pending,
      excludePaths: listed.exclude,
    }, null, 2))
  }
  if (listed.pending.length) process.exitCode = 2
}
