import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { boardsDir } from '../tools.mjs'
import { BoardError } from './errors.mjs'
import { assertMitLicense } from './license.mjs'
import { BOARD_SOURCES, GAMES } from './sources.mjs'

/** 唯一的棋类根目录：<数据目录>/boards（见 ../tools.mjs boardsDir）。下载、读取、页面都走这里。 */
export function boardsRoot() {
  return boardsDir()
}

export function sourceDir(id) {
  return join(boardsRoot(), 'src', id)
}

function markerFile(id) {
  return join(boardsRoot(), 'src', `${id}.commit`)
}

function readMarker(id) {
  try { return readFileSync(markerFile(id), 'utf8').trim() } catch { return '' }
}

/** 依赖这份源码的棋种。 */
function gamesUsing(id) {
  return Object.values(GAMES).filter((game) => game.sources.includes(id)).map((game) => game.id)
}

/** 删掉某棋种所有编译产物（runtime/<game>.mjs、runtime/<game>-<commit8>.mjs）。 */
export function clearRuntime(game) {
  const dir = join(boardsRoot(), 'runtime')
  let names = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (name === `${game}.mjs` || (name.startsWith(`${game}-`) && name.endsWith('.mjs'))) {
      rmSync(join(dir, name), { force: true })
    }
  }
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let err = ''
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (error) => reject(new BoardError(error.message || 'git 无法启动')))
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new BoardError((err || out || 'git 失败').trim().slice(0, 500)))
    })
  })
}

async function revParse(dir) {
  return git(['rev-parse', 'HEAD'], dir)
}

/**
 * 把钉死的提交检出到空目录。成功后调用方再校验 LICENSE。
 * @returns {Promise<string>} 检出的提交（附注标签会剥成提交号）
 */
export async function checkoutPinned(dir, repo, commit) {
  await mkdir(dir, { recursive: true })
  await git(['init'], dir)
  await git(['remote', 'add', 'origin', repo], dir)
  await git(['fetch', '--depth', '1', 'origin', commit], dir)
  await git(['checkout', '--detach', 'FETCH_HEAD'], dir)
  return revParse(dir)
}

export async function ensureSource(source) {
  const dir = sourceDir(source.id)
  const marked = readMarker(source.id)
  if (marked === source.commit && existsSync(join(dir, 'LICENSE'))) {
    assertMitLicense(dir)
    return dir
  }
  if (existsSync(join(dir, '.git'))) {
    try {
      const sha = await revParse(dir)
      if (sha === source.commit) {
        assertMitLicense(dir)
        mkdirSync(join(boardsRoot(), 'src'), { recursive: true })
        writeFileSync(markerFile(source.id), source.commit + '\n', 'utf8')
        return dir
      }
    } catch { /* 重新检出 */ }
  }
  // 重新下载：先清掉依赖这份源码的编译产物
  for (const game of gamesUsing(source.id)) clearRuntime(game)
  rmSync(dir, { recursive: true, force: true })
  try {
    const sha = await checkoutPinned(dir, source.repo, source.commit)
    if (sha !== source.commit) {
      rmSync(dir, { recursive: true, force: true })
      throw new BoardError(`${source.label} 检出的提交与钉死的版本不一致`)
    }
    assertMitLicense(dir)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    if (error instanceof BoardError) throw error
    throw new BoardError(error?.message || '下载失败')
  }
  mkdirSync(join(boardsRoot(), 'src'), { recursive: true })
  writeFileSync(markerFile(source.id), source.commit + '\n', 'utf8')
  return dir
}

export async function ensureGame(game) {
  const spec = GAMES[game]
  if (!spec) throw new BoardError('未知的棋种')
  const dirs = {}
  for (const id of spec.sources) dirs[id] = await ensureSource(BOARD_SOURCES[id])
  return dirs
}

function sourceReady(id) {
  const source = BOARD_SOURCES[id]
  if (!source) return false
  return readMarker(id) === source.commit && existsSync(join(sourceDir(id), 'LICENSE'))
}

/** 按棋种汇总。一类里的依赖全部就绪才算已下载。 */
export function gameStatus() {
  return Object.values(GAMES).map((game) => ({
    id: game.id,
    label: game.label,
    ready: game.sources.every((id) => sourceReady(id)),
  }))
}
