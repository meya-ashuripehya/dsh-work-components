/**
 * 回合内重复调用拦截的豁免：快照 / 截图类「看一眼当前画面」的工具不拦（所有者决定「快照、截图类工具不拦」）。
 * 点一下、看一眼、再点一下……这类工具参数相同但每次结果不同，按「同名同参第 3 次」拦截会误伤。
 * 只放行快照 / 截图类，不放行一般的读取工具。回合的步数上限照常约束总调用次数。
 *
 * 匹配：去掉 MCP 前缀（mcp__chrome__、mcp_windows__ …），驼峰转下划线，不区分大小写；
 *   - 以 snapshot / screenshot / screen_shot 结尾，且前面的词只来自一个很小的集合（take、get、capture、browser、page、viewport…），
 *     例：take_snapshot、take_screenshot（Chrome DevTools）、Screenshot、Snapshot（Windows-MCP）、get_viewport_screenshot（Blender）、
 *     figma_take_screenshot、figma_capture_screenshot（Figma Console）、browser_snapshot、capture_web_screenshot；
 *   - capture_screen / screen_capture / screencapture（同样可带这些前缀词）；
 *   - Windows-MCP 旧名 State-Tool（即现在的 Snapshot）。
 *   不匹配：take_heapsnapshot、memory_snapshot、compare_screenshot、upload_screenshot、get_world_state_snapshot 等。
 */
const PREFIX_WORDS = new Set(['take', 'get', 'capture', 'grab', 'browser', 'page', 'web', 'viewport', 'window', 'desktop', 'screen', 'full', 'element', 'app', 'figma', 'chrome', 'current', 'new'])
const LEGACY = new Set(['state_tool'])

/** 去掉 MCP 前缀并规范成小写下划线形式。 */
export function bareToolName(name) {
  let s = String(name || '').trim()
  const m = /^mcp_+.+?__(.+)$/i.exec(s)
  if (m) s = m[1]
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s.\-/]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase()
}

/** 快照 / 截图类工具：不参与回合内重复调用拦截（也不计数）。 */
export function isRepeatExempt(name) {
  const s = bareToolName(name)
  if (!s) return false
  if (LEGACY.has(s)) return true
  const words = s.split('_')
  let head
  if (/^(snapshot|screenshot|screencapture)$/.test(words[words.length - 1])) head = words.slice(0, -1)
  else if (words.length >= 2 && /^(screen_shot|screen_capture|capture_screen)$/.test(words.slice(-2).join('_'))) head = words.slice(0, -2)
  else return false
  return head.every((w) => PREFIX_WORDS.has(w))
}
