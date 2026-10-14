import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { BoardError } from './errors.mjs'
import { playerName } from './names.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame } from './session.mjs'
import { telegramOriginFor } from './telegram.mjs'
import { computeHints, hintMs } from './assist/hints.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

function fail(error) {
  if (error instanceof BoardError) throw error
  throw new BoardError(error?.message || '棋局操作失败')
}

/**
 * 装了辅助引擎时附上 hints（前三名候选与 AI 视角胜率）；没装或失败时原样返回。
 * 只在未终局时做；board_play 后轮到对方时给的是对方可能的应着。
 */
async function withHints(view, cfg) {
  if (!view || view.over || view.turn === 'over') return view
  const hints = await computeHints({ ms: hintMs(cfg) })
  return hints ? { ...view, hints } : view
}

/** @param {{ getConfig?: () => object }} options */
export function createBoardsTools(options = {}) {
  const getConfig = options.getConfig || (() => ({}))

  const openTool = defineTool({
    name: 'board_open',
    description: '打开一盘棋并在对话右侧显示棋盘。game 为 xiangqi（中国象棋）、chess（国际象棋）、gomoku（五子棋）、go（围棋）。aiSide 指定你执哪一方。同一时间只能有一局。缺棋盘时会先下载 MIT 项目。你执先手时要立刻 board_play；对方执先手时先等待，对方落子后再 board_look 并应着。不要使用这些棋库自带的对手。每种棋各有一份本地存档：上次未下完的同种棋会从存档续局（沿用存档里的执子方，返回 resumed 说明已走步数和轮到谁）；上次已终局则开新局，并在 lastResult 中给出上一局结果。',
    parameters: {
      game: { type: 'string', required: true, description: 'xiangqi、chess、gomoku、go 之一。' },
      aiSide: { type: 'string', required: true, description: '你执的一方。中国象棋用 red 或 black；国际象棋用 white 或 black；五子棋和围棋用 black 或 white。也可以用红、黑、白。' },
      strict: { type: 'boolean', description: '只对围棋有效。默认 true，禁止覆盖、自杀和立刻还原上一步。false 时关掉这三项，提子仍然计算。' },
      opponent: { type: 'string', description: '可选，只在 Telegram 群里有用：允许走棋的对手的 Telegram 数字用户 ID。默认只有发起这局的人能走。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cfg = getConfig() || {}
      const origin = telegramOriginFor(exec?.agent?.id, args.opponent)
      const view = await openSession({
        game: args.game,
        aiSide: args.aiSide,
        strict: args.strict,
        playerName: playerName(cfg.boardsPlayerName),
        ...(origin ? { origin } : {}),
      }).catch(fail)
      return view.turn === 'ai' ? withHints(view, cfg) : view
    },
  })

  const lookTool = defineTool({
    name: 'board_look',
    description: '查看当前棋局：轮到谁、局面、合法着法和是否终局。对方落子后用它确认局面，再 board_play。若设置里下载了辅助引擎，还会附 hints：前三名候选着法与你方胜率，仅供参考。',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute() {
      return withHints(lookSession(), getConfig() || {})
    },
  })

  const playTool = defineTool({
    name: 'board_play',
    description: '走你这一方的棋。着法必须来自 board_open 或 board_look 返回的 legal。中国象棋如 车1进1 或 1,9-1,8；国际象棋如 e2e4；五子棋如 H8；围棋如 D4，停着写 pass。非法着法会被拒绝，局面不变。',
    parameters: {
      move: { type: 'string', required: true, description: '一步合法着法。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      const played = await playSession(args.move, 'ai').catch(fail)
      return withHints(played.view, getConfig() || {})
    },
  })

  const closeTool = defineTool({
    name: 'board_close',
    description: '关闭右侧棋盘。未终局的棋局存档会保留，下次 board_open 同一种棋时从该局面续局；不想续局请用 board_reset。',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute() {
      return closeSession()
    },
  })

  const resetTool = defineTool({
    name: 'board_reset',
    description: '清除某种棋的本地存档并从初始局面重新开局。game 省略时指当前棋局。若该种棋正在进行，则就地重开并重新显示棋盘（来自 Telegram 的棋局会重新发送棋盘图片）；若未在进行，仅清除存档，下次 board_open 将开新局。',
    parameters: {
      game: { type: 'string', description: '可选，xiangqi、chess、gomoku、go 之一。省略时为当前棋局。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      return resetGame(args.game).catch(fail)
    },
  })

  const hintTool = defineTool({
    name: 'board_hint',
    description: '只读：用本机已下载的辅助引擎分析当前局面，返回轮到走棋一方的前三名候选着法与胜率（均按你方视角）。ms 为搜索毫秒数，默认按设置（约 1 秒）。没有下载辅助引擎、棋局已结束或引擎出错时 available 为 false。不改变棋局。',
    parameters: {
      ms: { type: 'number', description: '可选，搜索时长（毫秒），100–10000。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      lookSession()
      const ms = args.ms ? hintMs({ boardsHintMs: args.ms }) : hintMs(getConfig() || {})
      const hints = await computeHints({ ms })
      return hints ? { available: true, hints } : { available: false, reason: '没有可用的辅助引擎提示（未下载引擎、已终局或引擎暂不可用）。' }
    },
  })

  return [openTool, lookTool, playTool, closeTool, resetTool, hintTool]
}
