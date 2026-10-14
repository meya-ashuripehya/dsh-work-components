import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { CardError } from './errors.mjs'
import { assertAcceptableLicense, hasLicenseFile } from './license.mjs'
import { CARD_SOURCES, GAMES } from './sources.mjs'
import { assertGameSources } from './upstream.mjs'

/** 牌类根目录：<数据目录>/cards。与棋类 boards/ 分开。 */
export function cardsRoot() {
  return join(dataDir(), 'cards')
}

export function sourceDir(id) {
  return join(cardsRoot(), 'src', id)
}

function markerFile(id) {
  return join(cardsRoot(), 'src', `${id}.commit`)
}

function readMarker(id) {
  try { return readFileSync(markerFile(id), 'utf8').trim() } catch { return '' }
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let err = ''
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (error) => reject(new CardError(error.message || 'git 无法启动')))
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new CardError((err || out || 'git 失败').trim().slice(0, 500)))
    })
  })
}

async function revParse(dir) {
  return git(['rev-parse', 'HEAD'], dir)
}

export async function checkoutPinned(dir, repo, commit) {
  await mkdir(dir, { recursive: true })
  await git(['init'], dir)
  await git(['remote', 'add', 'origin', repo], dir)
  await git(['fetch', '--depth', '1', 'origin', commit], dir)
  await git(['checkout', '--detach', 'FETCH_HEAD'], dir)
  return revParse(dir)
}

function accept(dir, source) {
  assertAcceptableLicense(dir, source.license)
}

export async function ensureSource(source) {
  const dir = sourceDir(source.id)
  const marked = readMarker(source.id)
  if (marked === source.commit && hasLicenseFile(dir)) {
    accept(dir, source)
    return dir
  }
  if (existsSync(join(dir, '.git'))) {
    try {
      const sha = await revParse(dir)
      if (sha === source.commit) {
        accept(dir, source)
        mkdirSync(join(cardsRoot(), 'src'), { recursive: true })
        writeFileSync(markerFile(source.id), source.commit + '\n', 'utf8')
        return dir
      }
    } catch (error) {
      if (error instanceof CardError && /许可证|二十一点|RLCard|装载/.test(error.message)) throw error
    }
  }
  rmSync(dir, { recursive: true, force: true })
  try {
    const sha = await checkoutPinned(dir, source.repo, source.commit)
    if (sha !== source.commit) {
      rmSync(dir, { recursive: true, force: true })
      throw new CardError(`${source.label} 检出的提交与钉死的版本不一致`)
    }
    accept(dir, source)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    if (error instanceof CardError) throw error
    throw new CardError(error?.message || '下载失败')
  }
  mkdirSync(join(cardsRoot(), 'src'), { recursive: true })
  writeFileSync(markerFile(source.id), source.commit + '\n', 'utf8')
  return dir
}

let pending = null

export async function ensureGame(game) {
  const spec = GAMES[game]
  if (!spec) throw new CardError('未知的牌类')
  if (!pending) {
    pending = (async () => {
      const dirs = {}
      for (const id of new Set(Object.values(GAMES).flatMap((item) => item.sources))) {
        if (CARD_SOURCES[id]) dirs[id] = await ensureSource(CARD_SOURCES[id])
      }
      return dirs
    })().finally(() => { pending = null })
  }
  const dirs = await pending
  for (const id of spec.sources) assertGameSources(dirs[id], game)
  return dirs
}

function licenseReady(id) {
  const source = CARD_SOURCES[id]
  if (!source) return false
  if (readMarker(id) !== source.commit || !hasLicenseFile(sourceDir(id))) return false
  try {
    assertAcceptableLicense(sourceDir(id), source.license)
    return true
  } catch {
    return false
  }
}

export function gameStatus() {
  return Object.values(GAMES).map((game) => {
    const source = CARD_SOURCES[game.sources[0]]
    let ready = game.sources.every((id) => licenseReady(id))
    if (ready) {
      try { assertGameSources(sourceDir(source.id), game.id) } catch { ready = false }
    }
    return {
      id: game.id,
      label: game.label,
      ready,
      repo: source.page,
      license: source.license,
      commit: source.commit,
      note: game.note || '不随本插件分发。只接受 MIT、BSD、ISC、Apache-2.0，且必须与声明的许可证一致。不使用上游对局智能体。',
    }
  })
}
