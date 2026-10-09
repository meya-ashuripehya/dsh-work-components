// 构建宿主半边：src/index.mjs → lib/index.mjs（自包含，零外部依赖）；
// 另外两个独立入口：lib/local-loader-worker.mjs（fork 出来的本地组件加载进程）和
// lib/component-sdk.mjs（本地组件用的 helper；发布包里没有 src/）。
// defineTool 用 vendor/dsh-tools 里从 DSH 2.0.13 拷来的副本（npm 上的版本太旧），
// 所以构建不需要安装或解包 DSH Desktop。DSH 升级后可用 `npm run vendor:sync` 重新同步。
// 客户端 lib/client.js 为手写文件，不参与构建。
// 最后按需构建桌面控制经纪人（scripts/build-desktop.mjs；本机没有 dotnet 时只提示）。
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const BANNER = [
  '/* dsh-workbench. Original code: MIT, Copyright (c) 2026 dsh-workbench contributors. See LICENSE.',
  ' * Bundled portions of @deepseek-ai/dsh-tools, @deepseek-ai/dsh-util-values, and HarnessError',
  ' * from @deepseek-ai/dsh-llm: Copyright (c) 2026 DeepSeek, MIT. See vendor/dsh-tools/LICENSE and NOTICE.',
  ' */',
  "import { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);",
].join('\n')

await build({
  entryPoints: [join(root, 'src', 'index.mjs')],
  outfile: join(root, 'lib', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  alias: { '@dsh/define-tool': join(root, 'vendor', 'dsh-tools', 'schema.js') },
  banner: { js: BANNER },
  logLevel: 'info',
})

// Worker must remain a real on-disk file for child_process.fork (not bundled into index.mjs);
// bundle it on its own so its imports (connect-lib) don't point at src/, which is not published.
// The component SDK is a separate file so local components can import it from outside the package.
for (const [entry, out] of [
  [join(root, 'src', 'components', 'local-loader-worker.mjs'), join(root, 'lib', 'local-loader-worker.mjs')],
  [join(root, 'src', 'component-sdk.mjs'), join(root, 'lib', 'component-sdk.mjs')],
]) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: BANNER },
    logLevel: 'info',
  })
}

// 「通道」分组的 Telegram 运行时：src/channels/telegram/runtime.mjs → lib/channel-telegram.mjs。
// 只在卡片里打开「启用」后才由 lib/index.mjs 动态 import，关闭时不加载。
// @wsz987/channel-{core,harness,telegram} 一律解析到 vendor/wsz987/<pkg>（npm 0.5.1 + vendor/wsz987/patches/*.patch，
// 由 `npm run vendor:channels` 生成、`npm run check` 校验），所以 npm install 不会把补丁冲掉。
// 其余依赖（dsh-agent、dsh-llm、undici 等）从 node_modules 打包进来（版本由 devDependencies 精确锁定）。
const CHANNEL_PKG = /^@wsz987\/(channel-core|channel-harness|channel-telegram)(\/plugin)?$/
const vendorChannels = {
  name: 'vendor-wsz987-channels',
  setup(b) {
    b.onResolve({ filter: /^@wsz987\// }, (args) => {
      const m = CHANNEL_PKG.exec(args.path)
      if (!m) return undefined // 未打补丁的 @wsz987 包（如 channel-control）照常从 node_modules 解析
      return { path: join(root, 'vendor', 'wsz987', m[1], 'lib', m[2] ? 'plugin.js' : 'index.js') }
    })
    // dsh-llm 运行时 createRequire(import.meta.url)('../package.json') 读自身版本；打包后该相对路径会指到别处，
    // 这里换成构建时读到的版本常量。
    b.onLoad({ filter: /[\\/]node_modules[\\/](@deepseek-ai[\\/])?dsh-[a-z-]+[\\/].*\.js$/ }, async (args) => {
      const { readFile } = await import('node:fs/promises')
      let text = await readFile(args.path, 'utf8')
      const re = /createRequire\(import\.meta\.url\)\((['"])\.\.\/package\.json\1\)/g
      if (!re.test(text)) return undefined
      const pkgDir = args.path.replace(/[\\/](lib|dist)[\\/].*$/, '')
      const { version, name } = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
      text = text.replace(re, () => `(${JSON.stringify({ name, version })})`)
      return { contents: text, loader: 'js' }
    })
  },
}
await build({
  entryPoints: [join(root, 'src', 'channels', 'telegram', 'runtime.mjs')],
  outfile: join(root, 'lib', 'channel-telegram.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [vendorChannels],
  banner: {
    js: [
      '/* dsh-workbench Telegram channel runtime (loaded only when the 通道 › Telegram toggle is on).',
      ' * Bundled: @wsz987/channel-core, channel-harness, channel-telegram 0.5.1 (MIT, wsz987/dsh-channels) with patches',
      ' * from vendor/wsz987/patches; DeepSeek Harness packages (MIT); undici (MIT). See NOTICE.',
      ' */',
      "import { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
})

// 桌面控制经纪人：dist 缺失或源码更新时 dotnet publish；没有 dotnet 时提示并跳过（CI 发布用 npm run build:desktop -- --require）。
execFileSync(process.execPath, [join(root, 'scripts', 'build-desktop.mjs')], { stdio: 'inherit' })
