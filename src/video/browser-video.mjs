/** TikTok / 抖音：复用 Chrome 组件的浏览器会话取媒体地址，流式下载；不使用 yt-dlp。 */
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fetch as httpFetch, ProxyAgent } from 'undici'
import { callMcpTool, jsonOf } from '../connect-lib.mjs'
import { shortVideoLink } from '../chatroom/video.mjs'

// 序列化浏览器操作，兼容依赖“当前标签页”的旧版 Chrome MCP；下载不占此锁。
export function createBrowserVideo({ getTools, getConfig = () => ({}), call = callMcpTool, fetchImpl = httpFetch, wait = delay, timeoutMs = 120000 } = {}) {
  let tail = Promise.resolve()
  const resolvedLinks = new Map()
  const invoke = async (name, args, timeout = 15000) => {
    const r = await call(getTools?.(), 'chrome', name, args, timeout)
    if (!r.ok || r.value?.isError) throw new Error(r.missing ? '请启用并连接「工作组件 › Chrome」，TikTok / 抖音通过浏览器获取视频。' : `Chrome ${name} 失败，请检查浏览器连接后重试。`)
    return r
  }
  async function extract(link, signal) {
    signal?.throwIfAborted()
    if (getConfig().chromeEnabled === false) throw new Error('请启用「工作组件 › Chrome」，TikTok / 抖音通过浏览器获取视频。')
    let pages = (await invoke('list_pages', {})).text || ''
    const rows = [...pages.matchAll(/^\s*(\d+):\s+(https?:\/\/\S+)/gm)]
    const previousIds = new Set(rows.map((m) => m[1]))
    let page = rows.find((m) => {
      const p = shortVideoLink(m[2])
      return p && p.kind === link.kind && (p.id === link.id || p.url === link.url || p.url === resolvedLinks.get(link.url))
    })
    if (!page) {
      // 导航超时仍可能已创建页面：抖音实测需要继续等待页面初始化。
      try { await invoke('new_page', { url: link.url, background: false, timeout: 25000 }, 30000) } catch (e) {
        if (/请启用/.test(e.message)) throw e
      }
      pages = (await invoke('list_pages', {})).text || ''
      page = [...pages.matchAll(/^\s*(\d+):\s+(https?:\/\/\S+)/gm)].reverse().find((m) => {
        const p = shortVideoLink(m[2])
        return p && p.kind === link.kind && (p.id === link.id || p.url === link.url || (link.id.startsWith('share-') && !previousIds.has(m[1])))
      })
    }
    if (!page) throw new Error('未找到视频标签页，请在 Chrome 中打开分享链接后重试。')
    const pageId = Number(page[1])
    await invoke('select_page', { pageId })
    const deadline = Date.now() + timeoutMs
    let state
    do {
      signal?.throwIfAborted()
      const r = await invoke('evaluate_script', { pageId, function: `(${readVideoPage.toString()})()`, waitForStableDom: false })
      const fenced = r.text?.match(/```(?:json)?\s*([\s\S]*?)```/)
      try { state = fenced ? JSON.parse(fenced[1]) : jsonOf(r) } catch { state = null }
      const canonical = shortVideoLink(state?.pageUrl)
      if (canonical && canonical.kind === link.kind && (canonical.id === link.id || link.id.startsWith('share-'))) {
        resolvedLinks.set(link.url, canonical.url)
        if (resolvedLinks.size > 200) resolvedLinks.delete(resolvedLinks.keys().next().value)
        if (state?.url && allowedMediaUrl(state.url, link.kind)) return { ...state, id: canonical.id, referer: canonical.url }
      }
      await wait(1500, undefined, { signal })
    } while (Date.now() < deadline)
    throw new Error(state?.blocked ? '页面要求登录或验证码：请在 Chrome 中完成后重新调用；不会自动绕过验证。' : '浏览器尚未取得可下载视频（可能仍在加载、视频受限或为图文作品）。请确认页面能播放后重试。')
  }
  async function download(url, dir, { maxBytes, signal } = {}) {
    const link = shortVideoLink(url)
    if (!link) return { ok: false, error: '不是受支持的 TikTok / 抖音视频链接。' }
    let file, handle, dispatcher
    try {
      const job = tail.then(() => extract(link, signal))
      tail = job.catch(() => {})
      const media = await job
      signal?.throwIfAborted()
      const proxy = link.kind === 'tiktok' ? String(getConfig().proxy || '').trim() : ''
      if (proxy) dispatcher = new ProxyAgent(proxy)
      const budget = AbortSignal.timeout(330000)
      const downloadSignal = signal ? AbortSignal.any([signal, budget]) : budget
      let current = media.url, res
      for (let hop = 0; hop < 6; hop++) {
        if (!allowedMediaUrl(current, link.kind)) throw new Error('视频资源地址不属于受支持的平台 CDN。')
        res = await fetchImpl(current, { signal: downloadSignal, dispatcher, redirect: 'manual', headers: { 'user-agent': media.userAgent, referer: media.referer, 'accept-encoding': 'identity' } })
        if (![301, 302, 303, 307, 308].includes(res.status)) break
        const location = res.headers.get('location')
        await res.body?.cancel()
        if (!location || hop === 5) throw new Error('视频下载重定向失败。')
        current = new URL(location, current).href
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`视频下载被拒绝（HTTP ${res.status}），请刷新浏览器视频页面后重试。`) }
      const size = Number(res.headers.get('content-length')) || 0
      const tooLarge = () => new Error(`视频超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限，请压缩或截取后上传视频文件。`)
      if (maxBytes > 0 && size > maxBytes) { await res.body?.cancel(); throw tooLarge() }
      const type = res.headers.get('content-type') || ''
      if (/text\/|json|mpegurl|dash\+xml/i.test(type)) { await res.body?.cancel(); throw new Error('取得的资源不是可上传的视频文件，请确认页面能播放后重试。') }
      file = join(dir, `${link.kind}-${media.id}-${randomUUID()}.mp4`)
      handle = await open(file + '.part', 'wx')
      let bytes = 0, prefix = Buffer.alloc(0)
      for await (const chunk of res.body) {
        bytes += chunk.length
        if (prefix.length < 16) prefix = Buffer.concat([prefix, Buffer.from(chunk)]).subarray(0, 16)
        if (maxBytes > 0 && bytes > maxBytes) throw tooLarge()
        let offset = 0
        while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten
      }
      if (!bytes || (size && size !== bytes)) throw new Error('视频下载不完整，请重试。')
      if (prefix.toString('ascii', 4, 8) !== 'ftyp') throw new Error('视频资源不是受支持的 MP4 文件，请下载后手动上传。')
      await handle.close(); handle = null
      await rename(file + '.part', file)
      return { ok: true, path: file, bytes, title: media.title, duration: media.duration, canonicalUrl: media.referer }
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' || signal?.aborted ? '视频获取已取消或超时。' : e.message }
    } finally {
      await handle?.close().catch(() => {})
      if (file) await rm(file + '.part', { force: true }).catch(() => {})
      await dispatcher?.close().catch(() => {})
    }
  }
  return { download }
}

export function allowedMediaUrl(raw, kind) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
    const hosts = kind === 'douyin' ? ['douyinvod.com', 'douyin.com', 'douyincdn.com', 'idouyinvod.com'] : ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'tiktokv.us', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com']
    return hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
  } catch { return false }
}

/** 浏览器内执行，只返回当前作品的媒体信息；不读取或导出 Cookie。 */
export function readVideoPage() {
  const id = location.pathname.match(/\/(?:video|share\/video)\/(\d+)/)?.[1]
  const candidates = [...document.querySelectorAll('video')].map((v) => ({ v, r: v.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
  let url = candidates.map(({ v }) => v.currentSrc || v.src).find((s) => /^https:\/\//.test(s) && !s.includes('douyinstatic.com'))
  let title = document.title, duration = candidates[0]?.v.duration
  // TikTok 的 MSE/blob 播放器和抖音 SSR：从当前作品对应的结构化数据取直链。
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 35) return
    if (id && String(node.aweme_id || node.awemeId || node.id) === id && node.video) {
      const v = node.video
      const addr = v.playAddr || v.play_addr || v.downloadAddr
      const s = typeof addr === 'string' ? addr : (addr?.url_list || addr?.urlList)?.[0]
      if (s && /^https:\/\//.test(s)) url = s
      title = node.desc || title; duration = v.duration || duration
      return
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child, depth + 1)
  }
  for (const s of document.querySelectorAll('script[type="application/json"],script#RENDER_DATA,script#SIGI_STATE,script#__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
    try { const t = s.textContent.trim(); walk(JSON.parse(t.startsWith('%') ? decodeURIComponent(t) : t)) } catch {}
  }
  return { pageUrl: location.href, url, title: String(title).slice(0, 300), duration: Number.isFinite(duration) ? duration : 0, userAgent: navigator.userAgent, blocked: /验证码|验证后|verify to continue|log in to watch/i.test(document.body?.innerText || '') }
}
