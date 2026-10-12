import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { BoardError } from './errors.mjs'
import { playerName } from './names.mjs'
import { closeSession, lookSession, openSession, playSession } from './session.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

function fail(error) {
  if (error instanceof BoardError) throw error
  throw new BoardError(error?.message || '棋局操作失败')
}

/** @param {{ getConfig?: () => object }} options */
export function createBoardsTools(options = {}) {
  const getConfig = options.getConfig || (() => ({}))

  const openTool = defineTool({
    name: 'board_open',
    description: '打开一盘棋并在对话右侧显示棋盘。game 为 xiangqi（中国象棋）、chess（国际象棋）、gomoku（五子棋）、go（围棋）。aiSide 指定你执哪一方。同一时间只能有一局。缺棋盘时会先下载 MIT 项目。你执先手时要立刻 board_play；对方执先手时先等待，对方落子后再 board_look 并应着。不要使用这些棋库自带的对手。',
    parameters: {
      game: { type: 'string', required: true, description: 'xiangqi、chess、gomoku、go 之一。' },
      aiSide: { type: 'string', required: true, description: '你执的一方。中国象棋用 red 或 black；国际象棋用 white 或 black；五子棋和围棋用 black 或 white。也可以用红、黑、白。' },
      strict: { type: 'boolean', description: '只对围棋有效。默认 true，禁止覆盖、自杀和立刻还原上一步。false 时关掉这三项，提子仍然计算。' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args) {
      const cfg = getConfig() || {}
      return openSession({
        game: args.game,
        aiSide: args.aiSide,
        strict: args.strict,
        playerName: playerName(cfg.boardsPlayerName),
      }).catch(fail)
    },
  })

  const lookTool = defineTool({
    name: 'board_look',
    description: '查看当前棋局：轮到谁、局面、合法着法和是否终局。对方落子后用它确认局面，再 board_play。',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute() {
      return lookSession()
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
      return played.view
    },
  })

  const closeTool = defineTool({
    name: 'board_close',
    description: '关闭右侧棋盘并结束这一局。',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute() {
      return closeSession()
    },
  })

  return [openTool, lookTool, playTool, closeTool]
}
