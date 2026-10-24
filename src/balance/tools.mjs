/**
 * balance_query：查询「余额查询」卡片中已启用服务商的余额 / 已用金额。
 * 只返回金额、币种与查询时间，不含密钥；结果沿用约 60 秒的缓存。
 * Telegram 授权闸门：不在 OPEN_TOOLS 中，只有授权用户（所有者）触发的回合可用。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true },
    value: { type: 'number', required: true },
    currency: { type: 'string', required: true },
    type: { type: 'string', required: true },
  },
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    checkedAt: { type: 'string', required: true },
    items: { type: 'array', required: true, items: ITEM_SCHEMA },
    error: { type: 'string' },
    note: { type: 'string' },
  },
}

export const BALANCE_TOOL_NAME = 'balance_query'

/** @param {{ query: (provider?: string) => Promise<any[]> }} deps */
export function createBalanceTools({ query }) {
  const tool = defineTool({
    name: BALANCE_TOOL_NAME,
    description: 'Query account balance or spend for the AI providers the user configured in the "Balance query" settings card (official provider APIs only, each with its own separately saved key). type "balance" = remaining balance, "spend" = amount already used in the stated period, "info" = extra detail. Results are cached for about 60 seconds. Never returns keys.',
    parameters: {
      provider: { type: 'string', description: 'Optional provider id or name to query (e.g. "deepseek", "openrouter"). Omit to query every enabled provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { results: { type: 'array', required: true, items: RESULT_SCHEMA } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const results = await query(typeof args?.provider === 'string' && args.provider.trim() ? args.provider.trim() : undefined)
      return { results }
    },
  })
  return [tool]
}
