// 桌面控制经纪人：src/components/desktop/broker → broker/dist/DSHDesktopBroker.exe（dotnet publish，自包含单文件，win-x64）。
// 产物 73 MB 左右，不进 git（.gitignore 忽略 dist/）；npm 发布前由 CI 构建并随包分发，用户无需安装 .NET。
//   node scripts/build-desktop.mjs            需要时构建（dist 缺失或源码更新）；本机没有 dotnet 时只提示、不失败
//   node scripts/build-desktop.mjs --force    总是重新构建
//   node scripts/build-desktop.mjs --require  没有 dotnet 或构建失败时退出码非 0（CI / 发布用）
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const broker = join(root, 'src', 'components', 'desktop', 'broker')
const project = join(broker, 'DSHDesktopBroker.csproj')
const dist = join(broker, 'dist')
const exe = join(dist, 'DSHDesktopBroker.exe')
const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const require = args.has('--require')

function fail(msg) {
  if (require) { console.error(`build:desktop: ${msg}`); process.exit(1) }
  console.warn(`build:desktop: ${msg}（已跳过；桌面控制在本机构建前不可用）`)
  process.exit(0)
}

/** 源码（.cs / .csproj / app.manifest / global.json，不含 tests、bin、obj、dist）里最新的修改时间。 */
function newestSource(dir) {
  let newest = 0
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (['bin', 'obj', 'dist', 'tests'].includes(ent.name)) continue
      newest = Math.max(newest, newestSource(join(dir, ent.name)))
    } else if (/\.(cs|csproj|manifest|json)$/i.test(ent.name)) {
      newest = Math.max(newest, statSync(join(dir, ent.name)).mtimeMs)
    }
  }
  return newest
}

if (!existsSync(project)) fail('找不到 DSHDesktopBroker.csproj')
if (!force && existsSync(exe) && statSync(exe).mtimeMs >= newestSource(broker)) {
  console.log('build:desktop: dist/DSHDesktopBroker.exe 已是最新')
  process.exit(0)
}
try {
  execFileSync('dotnet', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
} catch {
  fail('未找到 dotnet（需要 .NET SDK 8 或更高版本）')
}
console.log('build:desktop: dotnet publish → src/components/desktop/broker/dist')
const r = spawnSync('dotnet', [
  'publish', project,
  '-c', 'Release',
  '-o', dist,
  '-p:EnableWindowsTargeting=true',
  '-nologo',
], { stdio: 'inherit', shell: process.platform === 'win32' })
if (r.status !== 0) fail(`dotnet publish 失败（退出码 ${r.status}）；若桌面控制正在运行，请先在设置页停用后再构建`)
if (!existsSync(exe)) fail('dotnet publish 完成但未生成 DSHDesktopBroker.exe')
console.log(`build:desktop: ok（${(statSync(exe).size / 1048576).toFixed(1)} MiB）`)
