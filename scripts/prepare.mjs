// Git 安装时补齐构建产物。发布包会去掉 prepare，避免消费端执行一条指向缺失文件的脚本。
// 手写的 lib/client.js 缺失时失败，不尝试构建它。其余产物缺一或比源码旧就整包重建。
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const handwritten = join(root, 'lib', 'client.js')
if (!existsSync(handwritten)) {
  console.error('prepare: lib/client.js 缺失。这是手写客户端，不能靠构建生成。')
  process.exit(1)
}

const required = [
  ['lib/index.mjs', 'src/index.mjs'],
  ['lib/local-loader-worker.mjs', 'src/components/local-loader-worker.mjs'],
  ['lib/component-sdk.mjs', 'src/component-sdk.mjs'],
  ['lib/channel-telegram.mjs', 'src/channels/telegram/runtime.mjs'],
  ['lib/channel-qq.mjs', 'src/channels/qq/runtime.mjs'],
  ['lib/gmail-server.mjs', 'src/components/gmail/server.mjs'],
]
const missing = []
for (const [out, src] of required) {
  const output = join(root, out)
  const source = join(root, src)
  if (!existsSync(output)) {
    missing.push(out)
    continue
  }
  if (existsSync(source) && statSync(source).mtimeMs > statSync(output).mtimeMs) missing.push(`${out} (older than ${src})`)
}
if (missing.length === 0) {
  console.log('prepare: 必要产物已齐全')
  process.exit(0)
}

console.log(`prepare: 需要构建（${missing.join(', ')}）`)
const cli = process.env.npm_execpath
const run = cli && /\.c?js$/i.test(cli)
  ? spawnSync(process.execPath, [cli, 'run', 'build'], { cwd: root, stdio: 'inherit', env: process.env })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
process.exit(run.status == null ? 1 : run.status)
