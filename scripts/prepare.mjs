// npm prepare：git 安装时若缺少构建产物则跑 build；npm 发布包已带 lib/ 时跳过，避免消费端无 esbuild 失败。
// 桌面 exe：由 scripts/build.mjs 末尾按需调用 build-desktop（无 dotnet 时跳过，不失败）。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const main = join(root, 'lib', 'index.mjs')
if (existsSync(main)) {
  console.log('prepare: lib/index.mjs 已存在，跳过构建')
  process.exit(0)
}

console.log('prepare: 缺少 lib/index.mjs，执行 npm run build…')
// 优先用调用本脚本的 npm（npm_execpath → node 直接跑 npm-cli.js）；Windows 上直接 spawn npm.cmd 不带 shell 会 EINVAL。
const cli = process.env.npm_execpath
const r = cli && /\.c?js$/i.test(cli)
  ? spawnSync(process.execPath, [cli, 'run', 'build'], { cwd: root, stdio: 'inherit', env: process.env })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
process.exit(r.status == null ? 1 : r.status)
