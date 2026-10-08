// 发布前检查（npm run check；prepublishOnly 在 build 之后跑）：
//  1. 入口与随包脚本 node --check；
//  2. lib/client.js 的 GameBot 字段与 src/components/gamebot/fields.mjs 一致；
//  3. package.json / package-lock.json / locale / icon 的发布元数据自洽。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const entries = [
  'lib/index.mjs',
  'lib/local-loader-worker.mjs',
  'lib/component-sdk.mjs',
  'lib/client.js',
  'src/components/gamebot/src/gamebot/adapters/civilization/dsh_session_io.mjs',
]
for (const rel of entries) {
  const file = join(root, rel)
  if (!existsSync(file)) { problems.push(`missing ${rel} (run npm run build)`); continue }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`node --check ${rel}: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
  }
}

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'gen-gamebot-fields.mjs'), '--check'], { stdio: 'pipe' })
} catch (error) {
  problems.push(String(error.stderr || error.stdout || error.message).trim())
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  problems.push(`package-lock.json version (${lock.version} / ${lock.packages?.['']?.version}) != package.json ${pkg.version}`)
}
const repo = String(pkg.repository?.url || '')
if (!/^(git\+)?https:\/\/github\.com\/meya-ashuripehya\/dsh-work-components(\.git)?$/.test(repo)) {
  problems.push(`repository.url must point at github.com/meya-ashuripehya/dsh-work-components (trusted publishing): ${repo || '(missing)'}`)
}
if (pkg.icon) {
  const icon = join(root, pkg.icon)
  if (!existsSync(icon)) problems.push(`icon ${pkg.icon} missing`)
  else if (statSync(icon).size > 256 * 1024) problems.push(`icon ${pkg.icon} larger than 256 KiB`)
}
for (const lang of ['en', 'zh']) {
  const file = join(root, 'locale', `${lang}.json`)
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')).meta
    if (!meta?.title || !meta?.description) problems.push(`locale/${lang}.json needs meta.title and meta.description`)
  } catch (error) {
    problems.push(`locale/${lang}.json: ${error.message}`)
  }
}
for (const need of ['locale/*.json', 'icon.svg', 'lib/index.mjs', 'lib/local-loader-worker.mjs', 'lib/component-sdk.mjs', 'lib/client.js', 'cordis.patch.yml']) {
  if (!pkg.files?.includes(need)) problems.push(`package.json files[] lacks ${need}`)
}

if (problems.length) {
  console.error('check failed:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`check ok: ${entries.length} entries parse, GameBot fields in sync, metadata consistent (v${pkg.version})`)
