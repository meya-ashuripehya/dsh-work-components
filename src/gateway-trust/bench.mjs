/**
 * llm-gateway-bench（MIT，另行下载）定位与动态导入。不随本插件分发、不拷贝进仓库：
 * 只使用设置页「网关核验」下载安装到 <数据目录>/tools/llm-gateway-bench 的副本，不读取其他位置。
 * 每次调用都重新检查该目录（按 metrics.mjs 的修改时间缓存导入结果），因此下载完成后无需重启 DSH 即可生效。
 * 未下载或导入失败时返回 { ok: false }：输入栏不显示「核验」开关，也不做任何判定。
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_EXPORTS = ['isBurstStream', 'evalModelEcho', 'evalCjkIntegrity', 'extractCachedTokens', 'evalCache', 'summarize']
export const NOT_INSTALLED = '未下载 llm-gateway-bench'

/** 目录 → probe/metrics.mjs 路径；不存在时 null。 */
export function metricsFile(dir) {
  if (!dir) return null
  const f = join(dir, 'probe', 'metrics.mjs')
  try { return existsSync(f) && statSync(f).isFile() ? f : null } catch { return null }
}

const cache = new Map()

/**
 * @param {string} managedDir 设置页下载安装的位置（<数据目录>/tools/llm-gateway-bench）
 * @returns {Promise<{ ok: true, installed: true, dir, file, mod } | { ok: false, installed: boolean, dir, reason }>}
 */
export async function loadBench(managedDir, { importImpl = (u) => import(u) } = {}) {
  const dir = managedDir ? resolve(managedDir) : ''
  const file = metricsFile(dir)
  if (!file) return { ok: false, installed: false, dir, reason: NOT_INSTALLED }
  let mtime = 0
  try { mtime = statSync(file).mtimeMs } catch { /* ignore */ }
  const key = file + '|' + mtime
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const mod = await importImpl(pathToFileURL(file).href + '?v=' + Math.round(mtime))
        const missing = REQUIRED_EXPORTS.filter((n) => typeof mod[n] !== 'function')
        if (missing.length) return { ok: false, installed: true, dir, reason: `llm-gateway-bench 缺少导出：${missing.join('、')}` }
        return { ok: true, installed: true, dir, file, mod }
      } catch (error) {
        return { ok: false, installed: true, dir, reason: `llm-gateway-bench 加载失败：${String(error?.message ?? error)}` }
      }
    })())
  }
  const got = await cache.get(key)
  // 导入失败不长期缓存：下次（例如重新下载后）再试一次。
  if (!got.ok) cache.delete(key)
  return got
}