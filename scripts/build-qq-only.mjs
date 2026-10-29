import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) === 'scripts'
  ? join(dirname(fileURLToPath(import.meta.url)), '..')
  : process.cwd()

const CHANNEL_PKG = /^@wsz987\/(channel-core|channel-harness|channel-telegram|channel-qq)(\/plugin)?$/
const vendorChannels = {
  name: 'vendor-wsz987-channels',
  setup(b) {
    b.onResolve({ filter: /^@wsz987\// }, (args) => {
      const m = CHANNEL_PKG.exec(args.path)
      if (!m) return undefined
      return { path: join(root, 'vendor', 'wsz987', m[1], 'lib', m[2] ? 'plugin.js' : 'index.js') }
    })
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
  entryPoints: [join(root, 'src', 'channels', 'qq', 'runtime.mjs')],
  outfile: join(root, 'lib', 'channel-qq.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [vendorChannels],
  banner: {
    js: [
      '/* dsh-workbench QQ channel runtime (loaded only when the 通道 › QQ toggle is on).',
      ' * Bundled: @wsz987/channel-core, channel-harness, channel-qq 0.5.1 (MIT, wsz987/dsh-channels);',
      ' * DeepSeek Harness packages (MIT); @tencent-connect/qqbot-nodejs. See NOTICE.',
      ' */',
      "import { createRequire as __mmCreateRequire } from 'node:module'; const require = __mmCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
})
console.log('channel-qq.mjs rebuilt')
