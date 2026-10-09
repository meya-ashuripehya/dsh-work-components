// 发布前检查（npm run check；prepublishOnly 在 build 之后跑）：
//  1. 入口与随包脚本 node --check；
//  2. lib/client.js 的 GameBot 字段与 src/components/gamebot/fields.mjs 一致；
//  3. package.json / package-lock.json / locale / icon 的发布元数据自洽；
//  4. 「通道」› Telegram：vendor/wsz987 与 npm 0.5.1 + vendor/wsz987/patches 一致（npm run vendor:channels -- --check），
//     lib/channel-telegram.mjs 带全部补丁标记，卡片字段与 src/channels/telegram 的设置键一致。
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
  'lib/channel-telegram.mjs',
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

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'vendor-channels.mjs'), '--check'], { stdio: 'pipe' })
} catch (error) {
  problems.push(String(error.stderr || error.stdout || error.message).trim())
}
if (existsSync(join(root, 'lib', 'channel-telegram.mjs'))) {
  try {
    const rt = await import(new URL('../lib/channel-telegram.mjs', import.meta.url).href)
    for (const [name, ok] of Object.entries(rt.PATCH_MARKERS || {})) if (!ok) problems.push(`lib/channel-telegram.mjs: patch marker ${name} missing (re-run npm run vendor:channels && npm run build)`)
    if (!Object.keys(rt.PATCH_MARKERS || {}).length) problems.push('lib/channel-telegram.mjs exports no PATCH_MARKERS')
  } catch (error) {
    problems.push(`import lib/channel-telegram.mjs: ${error.message}`)
  }
}
{
  const { TELEGRAM_KEYS, TELEGRAM_SECRET_KEY } = await import(new URL('../src/channels/telegram/index.mjs', import.meta.url).href)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const key of [...TELEGRAM_KEYS, TELEGRAM_SECRET_KEY]) {
    if (!client.includes(`key: "${key}"`)) problems.push(`lib/client.js lacks INPUT_FIELDS entry ${key}`)
  }
  if (!client.includes('group: "通道"')) problems.push('lib/client.js lacks the 通道 group')
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
for (const need of ['locale/*.json', 'icon.svg', 'lib/index.mjs', 'lib/local-loader-worker.mjs', 'lib/component-sdk.mjs', 'lib/channel-telegram.mjs', 'lib/client.js', 'cordis.patch.yml']) {
  if (!pkg.files?.includes(need)) problems.push(`package.json files[] lacks ${need}`)
}


// 发布（CI）时 npm 包必须带上桌面控制经纪人；本地开发可缺省（未装 dotnet 时 build 会跳过）。
if (process.env.CI && !existsSync(join(root, 'src', 'components', 'desktop', 'broker', 'dist', 'DSHDesktopBroker.exe'))) {
  problems.push('src/components/desktop/broker/dist/DSHDesktopBroker.exe missing (run npm run build:desktop -- --require)')
}

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'test-update.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push(String(error.stderr || error.stdout || error.message).trim() || 'scripts/test-update.mjs failed')
}

if (problems.length) {
  console.error('check failed:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`check ok: ${entries.length} entries parse, GameBot fields in sync, Telegram vendor/patches in sync, metadata consistent (v${pkg.version})`)
