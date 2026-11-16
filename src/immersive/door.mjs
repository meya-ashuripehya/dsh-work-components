/**
 * 「门」：沉浸前台角色唯一看得到的办事入口（errand）。
 *
 * 前台角色把要办的事写成一两句话交过来，这里同步等后台助手办完，把结果当作普通的一段话还回去；
 * 助手发出的图片（表情包、截图、生成图）作为 image 块一并带回，由通道回复管线按图片出站。
 * 办不成（超时、助手不可用、被拒绝）一律返回一句中性的「没办成」，不抛异常、不带技术细节，
 * 前台角色用自己的口吻转述即可，不会因为错误文本跳戏。
 *
 * 工具对谁都开放，谁能办什么不在这里判断：委托人是不是所有者由通道的所有者闸门决定
 * （bridge.isOwnerTurn），决定走哪种助手；陌生人走的助手只放行开放集合。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import {
  DOOR_NAME,
  DOOR_SCHEMA,
  DOOR_WHAT_DESCRIPTION,
  SOFT_FAIL,
  buildErrandPrompt,
  softFailText,
} from './policy.mjs'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
      images: { type: 'array' },
    },
  },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: String(value?.text ?? '') }]
    for (const ref of Array.isArray(value?.images) ? value.images : []) {
      if (ref && typeof ref.attachmentId === 'string') blocks.push({ type: 'image', attachment: ref })
    }
    return blocks
  },
}

function callerSessionId(exec) {
  return String(exec?.agent?.id || exec?.sessionId || '').trim()
}

/**
 * @param {{
 *   ask: (kind: 'owner'|'open', prompt: string, opts?: { timeoutMs?: number }) => Promise<{ ok: boolean, reason?: string, text?: string, images?: any[] }>,
 *   isOwnerTurn: (sessionId: string) => boolean,
 *   getTimeoutMs?: () => number,
 * }} deps
 */
export function createDoorTool(deps) {
  return defineTool({
    name: DOOR_NAME,
    description: DOOR_SCHEMA.description,
    parameters: {
      what: { type: 'string', required: true, description: DOOR_WHAT_DESCRIPTION },
    },
    output: OUTPUT,
    // 总时限在设置里最多 600 秒（含排队）；宿主的单次工具超时要比它更长，否则差事会被宿主先掐掉。
    timeoutMs: 11 * 60 * 1000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const what = String(args?.what ?? '').trim()
      if (!what) return { text: SOFT_FAIL.empty }
      const sessionId = callerSessionId(exec)
      let owner = false
      // 来源不明的调用方按非所有者处理（失败即关闭）。
      try { owner = sessionId ? deps.isOwnerTurn(sessionId) === true : false } catch { owner = false }
      let out
      try {
        out = await deps.ask(owner ? 'owner' : 'open', buildErrandPrompt({ what, owner }), { timeoutMs: deps.getTimeoutMs?.() })
      } catch {
        out = { ok: false, reason: 'failed' }
      }
      if (!out?.ok || !String(out.text ?? '').trim()) return { text: softFailText(out?.reason) }
      return { text: String(out.text), ...(Array.isArray(out.images) && out.images.length ? { images: out.images } : {}) }
    },
  })
}
