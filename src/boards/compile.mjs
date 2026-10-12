import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginRoot } from '../tools.mjs'
import { BoardError } from './errors.mjs'
import { boardsRoot } from './download.mjs'

function loadEsbuild() {
  const require = createRequire(pathToFileURL(join(pluginRoot(), 'package.json')).href)
  try {
    return require('esbuild')
  } catch {
    throw new BoardError('编译棋规需要插件目录里的 esbuild')
  }
}

export function runtimeFile(root, name) {
  return join(boardsRoot(root), 'runtime', name)
}

const inflight = new Map()

/** 把上游 TypeScript 打成一份可 import 的模块，写在数据目录，不改克隆下来的文件。 */
export function bundleEntry(root, name, build) {
  const outfile = runtimeFile(root, name)
  if (existsSync(outfile)) return Promise.resolve(outfile)
  const pending = inflight.get(outfile)
  if (pending) return pending
  const job = (async () => {
    if (!existsSync(outfile)) {
      await mkdir(dirname(outfile), { recursive: true })
      const esbuild = loadEsbuild()
      await esbuild.build({
        ...build,
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        logLevel: 'silent',
      })
    }
    return outfile
  })()
  inflight.set(outfile, job)
  return job.finally(() => { inflight.delete(outfile) })
}
