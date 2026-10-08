/**
 * GameBot 每个游戏的全部设置（工作组件设置页是唯一来源）。
 * - 设置键：gb_<game>_<GameBot 配置键>，Minecraft 驱动另有 gb_minecraft_driver。
 * - 值一律是字符串（与 GameBot config 相同；开关是 "1" / "0"，"" 表示继承 / 留空）。
 * - 下发：launch 时把本卡全部值 PATCH 到 GameBot /v1/games/<game>（见 toGameBotPatch）。
 * - lib/client.js 的 INPUT_FIELDS / FEATURES.keys 由 scripts/gen-gamebot-fields.mjs 从这里生成
 *   （npm run check / prepublishOnly 会用 --check 校验两边一致）。
 * - Minecraft 只提供 minaret 驱动：Mineflayer 需要的 Node 桥（minecraft-bridge）不随包发布。
 *   设置了环境变量 GAMEBOT_MINECRAFT_BRIDGE_DIR（指向装好依赖的桥目录）时，已存的 mineflayer 驱动值才会下发。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROVIDERS = ['openai', 'deepseek', 'xai', 'anthropic', 'ollama', 'custom']
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

const ONOFF = [{ value: '1', label: '开' }, { value: '0', label: '关' }]
const INHERIT_ONOFF = [{ value: '', label: '继承（跟随决策模型）' }, { value: '1', label: '开' }, { value: '0', label: '关' }]

/** kind: text | select | password(secret) | textarea。provider: 'LLM' / 'CHAT' 表示按服务商保存的 API 密钥。 */
function llmBlock(d) {
  return [
    { cfg: 'LLM_ENABLED', label: '决策大脑（LLM）', kind: 'select', options: ONOFF, def: d.LLM_ENABLED, desc: 'GameBot 自带大脑是否调用 LLM 做决策。【双脑】用 DSH 驱动时建议关闭。' },
    { cfg: 'LLM_PROVIDER', label: '决策服务商', kind: 'select', options: PROVIDERS, def: d.LLM_PROVIDER, desc: 'API 密钥按服务商保存，所有游戏共用同一服务商的密钥。' },
    { cfg: 'LLM_PROTOCOL', label: '决策协议', kind: 'select', options: PROTOCOLS, def: d.LLM_PROTOCOL },
    { cfg: 'LLM_BASE_URL', label: '决策 Base URL', kind: 'text', def: d.LLM_BASE_URL, desc: '留空用服务商默认地址。' },
    { cfg: 'LLM_MODEL', label: '决策模型', kind: 'text', def: d.LLM_MODEL },
    { cfg: 'LLM_API_KEY', label: '决策 API 密钥', kind: 'password', provider: 'LLM', def: '', desc: '留空 = 保持 GameBot 已存的该服务商密钥。' },
    { cfg: 'LLM_DECISION_TIMEOUT_S', label: '决策超时（秒）', kind: 'text', def: d.LLM_DECISION_TIMEOUT_S },
    { cfg: 'LLM_MAX_STEPS', label: '决策最大步数', kind: 'text', def: d.LLM_MAX_STEPS },
    { cfg: 'LLM_TEMPERATURE', label: '决策 temperature', kind: 'text', def: d.LLM_TEMPERATURE },
    { cfg: 'LLM_TOP_P', label: '决策 top_p', kind: 'text', def: d.LLM_TOP_P, desc: '留空用默认。' },
    { cfg: 'LLM_MAX_TOKENS', label: '决策 max_tokens', kind: 'text', def: d.LLM_MAX_TOKENS },
    { cfg: 'LLM_REASONING_EFFORT', label: '决策推理强度', kind: 'text', def: d.LLM_REASONING_EFFORT, desc: '如 none / low / medium / high；留空用默认。' },
    { cfg: 'LLM_THINKING_BUDGET', label: '决策思考预算', kind: 'text', def: d.LLM_THINKING_BUDGET },
    { cfg: 'LLM_PERSONA', label: '决策人设', kind: 'textarea', def: '', desc: '留空 = 使用 GameBot 默认人设。' },
    { cfg: 'CHAT_ENABLED', label: '聊天模型', kind: 'select', options: INHERIT_ONOFF, def: d.CHAT_ENABLED },
    { cfg: 'CHAT_PROVIDER', label: '聊天服务商', kind: 'select', options: [{ value: '', label: '继承' }, ...PROVIDERS], def: d.CHAT_PROVIDER },
    { cfg: 'CHAT_PROTOCOL', label: '聊天协议', kind: 'select', options: [{ value: '', label: '继承' }, ...PROTOCOLS], def: d.CHAT_PROTOCOL },
    { cfg: 'CHAT_BASE_URL', label: '聊天 Base URL', kind: 'text', def: d.CHAT_BASE_URL },
    { cfg: 'CHAT_MODEL', label: '聊天模型名', kind: 'text', def: d.CHAT_MODEL },
    { cfg: 'CHAT_API_KEY', label: '聊天 API 密钥', kind: 'password', provider: 'CHAT', def: '', desc: '按聊天服务商保存；留空 = 保持已存密钥。' },
    { cfg: 'CHAT_TEMPERATURE', label: '聊天 temperature', kind: 'text', def: d.CHAT_TEMPERATURE },
    { cfg: 'CHAT_TOP_P', label: '聊天 top_p', kind: 'text', def: d.CHAT_TOP_P },
    { cfg: 'CHAT_MAX_TOKENS', label: '聊天 max_tokens', kind: 'text', def: d.CHAT_MAX_TOKENS },
    { cfg: 'CHAT_REASONING_EFFORT', label: '聊天推理强度', kind: 'text', def: d.CHAT_REASONING_EFFORT },
    { cfg: 'CHAT_THINKING_BUDGET', label: '聊天思考预算', kind: 'text', def: d.CHAT_THINKING_BUDGET },
    { cfg: 'CHAT_PERSONA', label: '聊天人设', kind: 'textarea', def: '', desc: '留空 = 使用 GameBot 默认。' },
    { cfg: 'MEMORY_ENABLED', label: '记忆', kind: 'select', options: ONOFF, def: d.MEMORY_ENABLED },
    { cfg: 'MEMORY_BLOCK_SIZE', label: '记忆块大小', kind: 'text', def: d.MEMORY_BLOCK_SIZE },
    { cfg: 'DSH_SESSION', label: 'DSH 会话 id', kind: 'text', def: d.DSH_SESSION, desc: '可选：经 DSH 宿主内的陪玩桥把交流正文写入这个会话（不直接写会话文件）；留空不写。' },
  ]
}

const BASE_LLM = {
  LLM_ENABLED: '0', LLM_PROVIDER: 'openai', LLM_PROTOCOL: 'openai-completions', LLM_BASE_URL: '', LLM_MODEL: '',
  LLM_DECISION_TIMEOUT_S: '60', LLM_MAX_STEPS: '8', LLM_TEMPERATURE: '0.2', LLM_TOP_P: '', LLM_MAX_TOKENS: '',
  LLM_REASONING_EFFORT: '', LLM_THINKING_BUDGET: '', CHAT_ENABLED: '', CHAT_PROVIDER: '', CHAT_PROTOCOL: '',
  CHAT_BASE_URL: '', CHAT_MODEL: '', CHAT_TEMPERATURE: '', CHAT_TOP_P: '', CHAT_MAX_TOKENS: '',
  CHAT_REASONING_EFFORT: '', CHAT_THINKING_BUDGET: '', MEMORY_ENABLED: '1', MEMORY_BLOCK_SIZE: '6', DSH_SESSION: '',
}

export const GAME_FIELDS = {
  minecraft: [
    { cfg: 'driver', label: '驱动', kind: 'select', def: 'minaret', options: [{ value: 'minaret', label: 'minaret（NeoForge 模组 WebSocket）' }], desc: 'Mineflayer 驱动需要的 Node 桥不随插件提供，已隐藏。' },
    { cfg: 'NEOFORGE_WS_URL', label: 'NeoForge WS 地址', kind: 'text', def: 'ws://127.0.0.1:8765' },
    { cfg: 'NEOFORGE_WS_AUTH_USER', label: 'NeoForge WS 用户', kind: 'text', def: '' },
    { cfg: 'NEOFORGE_WS_AUTH_PASS', label: 'NeoForge WS 密码', kind: 'password', def: '' },
    { cfg: 'MC_USERNAME', label: '机器人用户名', kind: 'text', def: 'Player' },
    { cfg: 'MC_VERSION', label: 'MC 版本', kind: 'text', def: '1.21.1' },
    { cfg: 'MC_ARCHIVE', label: '存档 / 档案名', kind: 'text', def: '' },
    { cfg: 'MC_CHAT_FORWARD', label: '转发游戏聊天', kind: 'select', options: ONOFF, def: '1' },
    { cfg: 'MC_USE_TOOLS', label: '允许工具动作', kind: 'select', options: ONOFF, def: '1' },
    { cfg: 'MC_CHAT_PREFIX', label: '聊天触发前缀', kind: 'text', def: '', desc: '留空 = 所有聊天都处理。' },
    { cfg: 'MC_CHAT_COOLDOWN_MS', label: '聊天冷却（毫秒）', kind: 'text', def: '3000' },
    { cfg: 'MC_MODS_DIR', label: 'mods 目录', kind: 'text', def: '', desc: '安装 NeoForge 模组时使用的 .minecraft/versions/<版本>/mods。' },
    ...llmBlock(BASE_LLM),
  ],
  civilization: [
    { cfg: 'CIV6_MCP_PROJECT', label: 'civ6-mcp 项目目录', kind: 'text', def: '', desc: 'civ6-mcp 仓库所在目录；留空则沿用 GameBot 已存的值。' },
    { cfg: 'CIV6_MODS_DIR', label: '文明 VI Mods 目录', kind: 'text', def: '', desc: '…\\My Games\\Sid Meier\'s Civilization VI\\Mods，安装 TRIXCompanion 模组用。' },
    { cfg: 'CIV_POLL_INTERVAL_S', label: '轮询间隔（秒）', kind: 'text', def: '1' },
    { cfg: 'CIV_SAFE_AUTO', label: '安全自动（不主动结束回合）', kind: 'select', options: ONOFF, def: '1' },
    { cfg: 'CIV_DSH_SESSION', label: '文明 DSH 会话 id', kind: 'text', def: '', desc: '可选：经 DSH 宿主内的陪玩桥把评论写入这个会话（不直接写会话文件）；留空不写。' },
    ...llmBlock(BASE_LLM),
  ],
  vision: [
    { cfg: 'monitor', label: '显示器编号', kind: 'text', def: '1' },
    { cfg: 'max_px', label: '截图最长边（px）', kind: 'text', def: '1280' },
    { cfg: 'settle_s', label: '动作后等待（秒）', kind: 'text', def: '0.15' },
    { cfg: 'evidence_dir', label: '截图证据目录', kind: 'text', def: '', desc: '留空不保存。' },
  ],
}

export const settingKey = (game, cfg) => `gb_${game}_${cfg}`
export const gameSettingKeys = (game) => GAME_FIELDS[game].map((f) => settingKey(game, f.cfg))

/** SettingsSchema 片段（全部字符串；密钥 role('secret')）。 */
export function gamebotSchemaShape(z) {
  const shape = {}
  for (const [game, fields] of Object.entries(GAME_FIELDS)) {
    for (const f of fields) {
      let s = z.string()
      if (f.kind === 'password') s = s.role('secret')
      shape[settingKey(game, f.cfg)] = s.default(f.def ?? '').description(`GameBot · ${game} · ${f.label}`)
    }
  }
  shape.gamebotImported = z.boolean().default(false).description('内部：是否已从旧 GameBot 配置文件导入过一次设置。')
  return shape
}

const normProvider = (p) => {
  const v = String(p || '').trim().toLowerCase()
  return v || 'openai'
}

/** 外部 Mineflayer 桥（GAMEBOT_MINECRAFT_BRIDGE_DIR）是否可用；不可用时 Minecraft 驱动固定为 minaret。 */
export function mineflayerBridgeAvailable(env = process.env) {
  const dir = String(env.GAMEBOT_MINECRAFT_BRIDGE_DIR || '').trim()
  return !!dir && existsSync(join(dir, 'server.js'))
}

/** 卡片设置 → GameBot PATCH /v1/games/<game> 请求体。 */
export function toGameBotPatch(game, cfg) {
  const config = {}
  const providerKeys = {}
  let driver
  for (const f of GAME_FIELDS[game]) {
    const v = String(cfg[settingKey(game, f.cfg)] ?? f.def ?? '')
    if (f.cfg === 'driver') { driver = v || f.def; continue }
    if (f.provider) {
      // 服务商密钥跨游戏共用：只在填写时更新，留空不清掉已存的。
      if (v.trim()) {
        const prov = f.provider === 'LLM'
          ? normProvider(cfg[settingKey(game, 'LLM_PROVIDER')])
          : normProvider(cfg[settingKey(game, 'CHAT_PROVIDER')] || cfg[settingKey(game, 'LLM_PROVIDER')])
        providerKeys[prov] = v.trim()
      }
      continue
    }
    if (f.kind === 'textarea' && !v.trim()) continue // 留空 = GameBot 默认人设
    config[f.cfg] = v
  }
  if (game === 'minecraft' && driver && driver !== 'minaret' && !mineflayerBridgeAvailable()) driver = 'minaret'
  const body = { config }
  if (driver) body.driver = driver
  if (Object.keys(providerKeys).length) body.provider_keys = providerKeys
  return body
}

/** 一次性：从旧 GameBot data/game-configs.json 导入到卡片设置。返回补丁（不含时返回 null）。不打印任何值。 */
export function legacyImportPatch(candidates) {
  const file = candidates.find((p) => p && existsSync(p))
  if (!file) return null
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const keys = raw.provider_keys && typeof raw.provider_keys === 'object' ? raw.provider_keys : {}
  const patch = {}
  for (const [game, fields] of Object.entries(GAME_FIELDS)) {
    const stored = raw[game]
    if (!stored || typeof stored !== 'object') continue
    const c = stored.config && typeof stored.config === 'object' ? stored.config : {}
    for (const f of fields) {
      const k = settingKey(game, f.cfg)
      if (f.cfg === 'driver') { if (stored.driver) patch[k] = String(stored.driver); continue }
      if (f.provider) {
        const prov = f.provider === 'LLM' ? normProvider(c.LLM_PROVIDER) : (c.CHAT_PROVIDER ? normProvider(c.CHAT_PROVIDER) : '')
        const secret = prov ? String(keys[prov] || '').trim() : ''
        if (secret) patch[k] = secret
        continue
      }
      if (Object.prototype.hasOwnProperty.call(c, f.cfg) && c[f.cfg] != null) patch[k] = String(c[f.cfg])
    }
  }
  return { file, patch }
}

/** 旧设置导入只看用户显式填写的外部 GameBot 目录（gamebotRoot）；包内自带的代码没有旧设置。 */
export function legacyConfigCandidates(externalRoot) {
  const root = String(externalRoot || '').trim()
  return root ? [join(root, 'data', 'game-configs.json')] : []
}
