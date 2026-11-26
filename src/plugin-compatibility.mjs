/**
 * 与本机 @deepseek-ai/dsh-app-boot@0.2.2-rc.5 的 evaluatePluginCompatibility 同一规则。
 * 自身 engines.dsh 单独决定，有它时忽略 peerDependencies。
 * 否则只比较名为 @deepseek-ai/dsh 或以 @deepseek-ai/dsh- 开头的 peer。
 * peer 上的 workspace:^、workspace:~、workspace:* 表示当前运行时；engines.dsh 不接受这三种写法。
 * 没有 engines.dsh 且没有 peerDependencies 时返回 undefined。那是跳过，不是已兼容。
 * 不读取 peerDependenciesMeta.optional。测试不得用 allow-version 豁免把失败改成通过。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

function loadSemver() {
  const require = createRequire(import.meta.url)
  try { return require('semver') } catch { /* not a direct dependency */ }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'semver')
  if (existsSync(join(bundled, 'package.json'))) return require(bundled)
  throw new Error('找不到 semver。兼容性门控需要与官方 app-boot 相同的 semver.satisfies。')
}

const semver = loadSemver()
const WORKSPACE_RANGES = ['workspace:^', 'workspace:~', 'workspace:*']

function objectOf(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function runtimeVersionOf(value) {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(`invalid dsh runtime version: ${value}`)
  }
  return value
}

function satisfies(runtimeVersion, range) {
  return range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
}

function identityField(fields, key) {
  const value = fields[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Plugin manifest ${key} is required when peers do not match`)
  return value
}

export function unmetRequirements(fields, runtimeVersion) {
  const engines = Object.hasOwn(fields, 'engines') ? objectOf(fields.engines, 'Plugin manifest engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(fields, 'peerDependencies')) return {}
  const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies')
  const unmet = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = WORKSPACE_RANGES.includes(range) ? runtimeVersion : range
    if (!satisfies(runtimeVersion, requirement)) unmet[name] = range
  }
  return unmet
}

export function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion) {
  runtimeVersionOf(runtimeVersion)
  const fields = objectOf(manifest, 'Plugin manifest')
  const requirements = unmetRequirements(fields, runtimeVersion)
  if (Object.keys(requirements).length === 0) return undefined
  const name = identityField(fields, 'name')
  const version = identityField(fields, 'version')
  const key = `${name}@${version}`
  return {
    name,
    version,
    runtimeVersion,
    requirements,
    exempted: (Object.hasOwn(exemptions, key) ? exemptions[key] : undefined)?.includes(runtimeVersion) === true,
  }
}
