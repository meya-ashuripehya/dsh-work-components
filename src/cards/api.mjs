import { CardError } from './errors.mjs'
import { ensureGame, gameStatus } from './download.mjs'
import { cardsPage } from './page.mjs'
import { activeContextKey, lookSession, playSession } from './session.mjs'
import { GAMES } from './sources.mjs'

function crossSite(req) {
  return req.headers['sec-fetch-site'] === 'cross-site'
}

export async function handleCardsApi(req, res, sub, helpers) {
  if (sub !== '/cards' && !sub.startsWith('/cards/')) return false
  const { sendJson, readBody } = helpers
  try {
    if (sub === '/cards/status' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, games: gameStatus() })
      return true
    }
    if ((sub === '/cards/download' || sub === '/cards/download/') && req.method === 'POST') {
      if (crossSite(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true }
      const body = JSON.parse(await readBody(req) || '{}')
      const game = String(body.game || 'blackjack').trim()
      if (!GAMES[game]) throw new CardError(`game 只能是 ${Object.keys(GAMES).join('、')}`)
      await ensureGame(game)
      sendJson(res, 200, { ok: true, games: gameStatus() })
      return true
    }
    if (sub === '/cards/session' && req.method === 'GET') {
      const key = activeContextKey()
      if (!key) { sendJson(res, 200, { ok: true, open: false, session: null }); return true }
      try {
        sendJson(res, 200, { ok: true, open: true, session: lookSession(key) })
      } catch (error) {
        if (error instanceof CardError && error.status === 404) sendJson(res, 200, { ok: true, open: false, session: null })
        else throw error
      }
      return true
    }
    if (sub === '/cards/play' && req.method === 'POST') {
      if (crossSite(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true }
      const key = activeContextKey()
      if (!key) throw new CardError('没有进行中的牌局', 404)
      const body = JSON.parse(await readBody(req) || '{}')
      const played = await playSession(key, body.action, 'human')
      sendJson(res, 200, { ok: true, prompt: played.prompt, action: played.action, session: played.view })
      return true
    }
    return false
  } catch (error) {
    const status = error instanceof CardError ? (error.status || 400) : 400
    sendJson(res, status, { ok: false, error: error?.message || '牌局请求失败' })
    return true
  }
}

export function handleCardsPage(req, res, sub) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return true
  }
  if (sub === '/play' || sub === '/play/') {
    const html = cardsPage()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') res.end()
    else res.end(html)
    return true
  }
  return false
}
