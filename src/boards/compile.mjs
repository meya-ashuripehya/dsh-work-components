import { createRequire } from 'node:module'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginRoot } from '../tools.mjs'
import { BoardError } from './errors.mjs'
import { boardsRoot } from './download.mjs'
import { BOARD_SOURCES } from './sources.mjs'

function loadEsbuild() {
  const require = createRequire(pathToFileURL(join(pluginRoot(), 'package.json')).href)
  try {
    return require('esbuild')
  } catch {
    throw new BoardError('编译棋规需要插件目录里的 esbuild')
  }
}

/** 编译产物名带钉死提交的前 8 位：runtime/<game>-<commit8>.mjs。 */
export function runtimeName(game, commit) {
  return `${game}-${String(commit).slice(0, 8)}.mjs`
}

export function runtimeFile(name) {
  return join(boardsRoot(), 'runtime', name)
}

/** 删掉该棋种除 keep 以外的编译产物（含旧版无提交号的 <game>.mjs）。 */
function pruneRuntime(game, keep) {
  const dir = join(boardsRoot(), 'runtime')
  let names = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (name === keep) continue
    if (name === `${game}.mjs` || (name.startsWith(`${game}-`) && name.endsWith('.mjs'))) {
      try { rmSync(join(dir, name), { force: true }) } catch { /* 被占用时下次再删 */ }
    }
  }
}

const inflight = new Map()

/** 把上游 TypeScript 打成一份可 import 的模块，写在数据目录，不改克隆下来的文件。 */
export function bundleEntry(game, sourceId, build) {
  const source = BOARD_SOURCES[sourceId]
  if (!source) throw new BoardError('未知的棋盘源码')
  const name = runtimeName(game, source.commit)
  const outfile = runtimeFile(name)
  if (existsSync(outfile)) {
    pruneRuntime(game, name)
    return Promise.resolve(outfile)
  }
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
    pruneRuntime(game, name)
    return outfile
  })()
  inflight.set(outfile, job)
  return job.finally(() => { inflight.delete(outfile) })
}
