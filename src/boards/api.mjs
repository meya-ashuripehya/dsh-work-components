import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import { BoardError } from './errors.mjs'
import { ensureGame, gameStatus, sourceDir } from './download.mjs'
import { playerName } from './names.mjs'
import { boardsPage } from './page.mjs'
import { lookSession, playSession, setPlayerName } from './session.mjs'
import { BOARD_SOURCES, GAMES } from './sources.mjs'

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

function crossSite(req) {
  return req.headers['sec-fetch-site'] === 'cross-site'
}

export async function handleBoardsApi(req, res, sub, helpers) {
  if (sub !== '/boards' && !sub.startsWith('/boards/')) return false
  const { sendJson, readBody, getConfig } = helpers
  try {
    if (sub === '/boards/status' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, games: gameStatus() })
      return true
    }
    if ((sub === '/boards/download' || sub === '/boards/download/') && req.method === 'POST') {
      if (crossSite(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true }
      const body = JSON.parse(await readBody(req) || '{}')
      const game = String(body.game || '').trim()
      if (!GAMES[game]) throw new BoardError('game 只能是 xiangqi、chess、gomoku、go')
      await ensureGame(game)
      sendJson(res, 200, { ok: true, games: gameStatus() })
      return true
    }
    if (sub === '/boards/session' && req.method === 'GET') {
      try {
        sendJson(res, 200, { ok: true, open: true, session: lookSession() })
      } catch (error) {
        if (error instanceof BoardError && error.status === 404) sendJson(res, 200, { ok: true, open: false, session: null })
        else throw error
      }
      return true
    }
    if (sub === '/boards/move' && req.method === 'POST') {
      if (crossSite(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true }
      const body = JSON.parse(await readBody(req) || '{}')
      const cfg = getConfig() || {}
      setPlayerName(playerName(cfg.boardsPlayerName))
      const played = await playSession(body.move, 'human')
      sendJson(res, 200, { ok: true, prompt: played.prompt, notation: played.notation, session: played.view })
      return true
    }
    return false
  } catch (error) {
    const status = error instanceof BoardError ? (error.status || 400) : 400
    sendJson(res, status, { ok: false, error: error?.message || '棋局请求失败' })
    return true
  }
}

export function handleBoardsPage(req, res, sub) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return true
  }
  if (sub === '/play' || sub === '/play/') {
    const html = boardsPage()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') res.end()
    else res.end(html)
    return true
  }
  if (!sub.startsWith('/vendor/')) return false
  const rest = sub.slice('/vendor/'.length)
  const slash = rest.indexOf('/')
  const id = slash === -1 ? rest : rest.slice(0, slash)
  const rel = slash === -1 ? '' : rest.slice(slash + 1)
  if (!BOARD_SOURCES[id] || !rel || rel.includes('\0')) {
    res.writeHead(404); res.end('not found'); return true
  }
  const root = sourceDir(id)
  const full = resolve(root, decodeURIComponent(rel))
  const nested = relative(root, full)
  if (nested.startsWith('..') || nested.includes(`..${sep}`) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404); res.end('not found'); return true
  }
  const type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  if (req.method === 'HEAD') res.end()
  else createReadStream(full).pipe(res)
  return true
}
