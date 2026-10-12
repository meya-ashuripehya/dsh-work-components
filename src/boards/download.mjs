import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { BoardError } from './errors.mjs'
import { assertMitLicense } from './license.mjs'
import { BOARD_SOURCES, GAMES } from './sources.mjs'

export function boardsRoot(root) {
  return join(root || dataDir(), 'boards')
}

export function sourceDir(root, id) {
  return join(boardsRoot(root), 'src', id)
}

function markerFile(root, id) {
  return join(boardsRoot(root), 'src', `${id}.commit`)
}

function readMarker(root, id) {
  try { return readFileSync(markerFile(root, id), 'utf8').trim() } catch { return '' }
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

export async function ensureSource(root, source) {
  const dir = sourceDir(root, source.id)
  const marked = readMarker(root, source.id)
  if (marked === source.commit && existsSync(join(dir, 'LICENSE'))) {
    assertMitLicense(dir)
    return dir
  }
  if (existsSync(join(dir, '.git'))) {
    try {
      const sha = await revParse(dir)
      if (sha === source.commit) {
        assertMitLicense(dir)
        mkdirSync(join(boardsRoot(root), 'src'), { recursive: true })
        writeFileSync(markerFile(root, source.id), source.commit + '\n', 'utf8')
        return dir
      }
    } catch { /* 重新检出 */ }
  }
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
  mkdirSync(join(boardsRoot(root), 'src'), { recursive: true })
  writeFileSync(markerFile(root, source.id), source.commit + '\n', 'utf8')
  return dir
}

export async function ensureGame(game, root) {
  const spec = GAMES[game]
  if (!spec) throw new BoardError('未知的棋种')
  const dirs = {}
  for (const id of spec.sources) dirs[id] = await ensureSource(root, BOARD_SOURCES[id])
  return dirs
}

function sourceReady(root, id) {
  const source = BOARD_SOURCES[id]
  if (!source) return false
  return readMarker(root, id) === source.commit && existsSync(join(sourceDir(root, id), 'LICENSE'))
}

/** 按棋种汇总。一类里的依赖全部就绪才算已下载。 */
export function gameStatus(root) {
  return Object.values(GAMES).map((game) => ({
    id: game.id,
    label: game.label,
    ready: game.sources.every((id) => sourceReady(root, id)),
  }))
}
