/**
 * Scene / exclusivity routing for tool search.
 * Chatroom's flat LLM picker + "prefer current toolset" lets overlapping generalists
 * (e.g. windows MCP) permanently shadow specialists (desktop-control). Scenes fix that.
 */

/** @typedef {{ id: string, signals: RegExp[], preferServers: string[], demoteServers: string[], hint: string }} Scene */

/** @type {Scene[]} */
export const SCENES = [
  {
    id: 'desktop-ui',
    signals: [
      /桌面|控件|键鼠|截图|点击|鼠标|键盘|ui.?automat|desktop.?control|screenshot|click|mouse|keyboard|type.?text|hotkey|窗口控件|控件级/i,
      /\bmcp__desktop__/i,
    ],
    preferServers: ['desktop'],
    demoteServers: ['windows'],
    hint: 'Scene desktop-ui: for control-level click/type/screenshot/hotkey on the desktop, prefer mcp__desktop__* over mcp__windows__*. windows covers PowerShell/registry/files — do not pick it for UI automation when desktop tools exist.',
  },
  {
    id: 'windows-os',
    signals: [
      /powershell|注册表|registry|文件系统|explorer|win32|进程管理|服务管理|\bmcp__windows__/i,
      /cmd\.exe|wmi|计划任务|scheduled.?task/i,
    ],
    preferServers: ['windows'],
    demoteServers: [],
    hint: 'Scene windows-os: for PowerShell, registry, filesystem, services, prefer mcp__windows__*.',
  },
  {
    id: 'browser',
    signals: [/浏览器|chrome|devtools|网页|browser|puppeteer|playwright|\bmcp__chrome__/i],
    preferServers: ['chrome', 'chrome-devtools'],
    demoteServers: [],
    hint: 'Scene browser: prefer mcp__chrome__* / chrome-devtools for web page automation.',
  },
]

/**
 * Match query (and optional current tool names) to scenes.
 * @param {string} query
 * @param {{ current?: string[] }} [opts]
 */
export function matchScenes(query, opts = {}) {
  const q = String(query || '')
  const current = opts.current || []
  const hay = q + '\n' + current.join('\n')
  return SCENES.filter((s) => s.signals.some((re) => re.test(hay)))
}

/**
 * MCP server id from tool name: mcp__desktop__click → desktop
 * @param {string} name
 */
export function mcpServerOf(name) {
  const m = String(name || '').match(/^mcp__([^_]+)__/)
  return m ? m[1] : ''
}

/**
 * Annotate / reorder catalog for the selector:
 * - Prefer-server tools first with [preferred:scene] tag
 * - Demote-server tools last with [generalist; prefer X for scene] tag
 * When a scene prefers a specialist that exists in catalog, demoted tools stay
 * visible but clearly marked so the LLM does not treat them as equal.
 *
 * @param {Array<{name:string, description?:string}>} catalog
 * @param {Scene[]} scenes
 */
export function annotateCatalog(catalog, scenes) {
  if (!scenes.length) return { catalog: catalog.slice(), hints: [] }
  const prefer = new Set()
  const demote = new Set()
  const hints = []
  for (const s of scenes) {
    hints.push(s.hint)
    for (const x of s.preferServers) prefer.add(x)
    for (const x of s.demoteServers) demote.add(x)
  }
  // Only demote when at least one preferred specialist tool exists in catalog
  const hasPrefer = catalog.some((t) => prefer.has(mcpServerOf(t.name)))
  const tagged = catalog.map((t) => {
    const srv = mcpServerOf(t.name)
    let tag = ''
    if (prefer.has(srv)) tag = ' [preferred for matched scene]'
    else if (hasPrefer && demote.has(srv)) tag = ' [overlapping generalist — prefer specialist above for this scene]'
    const description = tag ? `${tag} ${t.description || ''}`.trim() : (t.description || '')
    return { ...t, description, _rank: prefer.has(srv) ? 0 : hasPrefer && demote.has(srv) ? 2 : 1 }
  })
  tagged.sort((a, b) => a._rank - b._rank || String(a.name).localeCompare(String(b.name)))
  return {
    catalog: tagged.map(({ _rank, ...rest }) => rest),
    hints,
  }
}

/**
 * Lexical fallback over FULL catalog (not just current toolset), scene-aware.
 * Prefer preferServers; skip demoteServers when specialists exist.
 * @param {string} query
 * @param {Array<{name:string}>} catalog
 * @param {Scene[]} scenes
 * @param {number} [max=3]
 */
/** Soft cap so one scene expand cannot blow the session pin budget (pins maxPerSession ≈ 64). */
export const SUITE_CAP = 48

/**
 * Full preferServers suite: every catalog tool whose MCP server is in the union
 * of matched scenes' preferServers. Used by find_tools to pin the whole suite
 * instead of sparse lexical/LLM top-N when a scene matches.
 * @param {Array<{name:string}>} catalog
 * @param {Scene[]} scenes
 * @param {number} [cap=SUITE_CAP]
 * @returns {string[]}
 */
export function suiteNamesForScenes(catalog, scenes, cap = SUITE_CAP) {
  if (!scenes?.length || !catalog?.length) return []
  const prefer = new Set(scenes.flatMap((s) => s.preferServers || []))
  if (!prefer.size) return []
  const names = []
  for (const t of catalog) {
    const n = String(t?.name || '').trim()
    if (!n) continue
    if (prefer.has(mcpServerOf(n))) names.push(n)
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) // ASCII-stable, locale-independent
  const limit = Math.max(1, Number(cap) || SUITE_CAP)
  return names.slice(0, limit)
}

export function lexicalSceneMatch(query, catalog, scenes, max = 3) {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  if (!tokens.length || !catalog?.length) return []
  const prefer = new Set(scenes.flatMap((s) => s.preferServers))
  const demote = new Set(scenes.flatMap((s) => s.demoteServers))
  const hasPrefer = catalog.some((t) => prefer.has(mcpServerOf(t.name)))
  const scored = []
  for (const t of catalog) {
    const srv = mcpServerOf(t.name)
    if (hasPrefer && demote.has(srv) && !prefer.has(srv)) continue
    const name = String(t.name || '').toLowerCase()
    let score = tokens.reduce((n, tok) => n + (name.includes(tok) ? 1 : 0), 0)
    if (!score) continue
    if (prefer.has(srv)) score += 10
    scored.push({ name: t.name, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, max).map((x) => x.name)
}
