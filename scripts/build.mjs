// 构建宿主半边：src/index.mjs → lib/index.mjs（自包含，零外部依赖）；
// 另外两个独立入口：lib/local-loader-worker.mjs（fork 出来的本地组件加载进程）和
// lib/component-sdk.mjs（本地组件用的 helper；发布包里没有 src/）。
// defineTool 用 vendor/dsh-tools 里从 DSH 2.0.13 拷来的副本（npm 上的版本太旧），
// 所以构建不需要安装或解包 DSH Desktop。DSH 升级后可用 `npm run vendor:sync` 重新同步。
// 客户端 lib/client.js 为手写文件，不参与构建。
import { build } from 'esbuild'
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
