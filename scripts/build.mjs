// 构建宿主半边：src/index.mjs → lib/index.mjs（自包含，零外部依赖）。
// defineTool 用 vendor/dsh-tools 里从 DSH 2.0.13 拷来的副本（npm 上的版本太旧），
// 所以构建不需要安装或解包 DSH Desktop。DSH 升级后可用 `npm run vendor:sync` 重新同步。
// 客户端 lib/client.js 为手写文件，不参与构建。
import { build } from 'esbuild'
import { copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

await build({
  entryPoints: [join(root, 'src', 'index.mjs')],
  outfile: join(root, 'lib', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  alias: { '@dsh/define-tool': join(root, 'vendor', 'dsh-tools', 'schema.js') },
  banner: {
    js: [
      '/* dsh-workbench. Original code: MIT, Copyright (c) 2026 dsh-workbench contributors. See LICENSE.',
      ' * Bundled portions of @deepseek-ai/dsh-tools, @deepseek-ai/dsh-util-values, and HarnessError',
      ' * from @deepseek-ai/dsh-llm: Copyright (c) 2026 DeepSeek, MIT. See vendor/dsh-tools/LICENSE and NOTICE.',
      ' */',
      "import { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
})

// Worker must remain a real on-disk file for child_process.fork (not bundled into index.mjs).
copyFileSync(
  join(root, 'src', 'components', 'local-loader-worker.mjs'),
  join(root, 'lib', 'local-loader-worker.mjs'),
)
console.log('copied lib/local-loader-worker.mjs')
