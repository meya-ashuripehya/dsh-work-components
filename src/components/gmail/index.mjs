/**
 * 工作组件：gmail（个人 Gmail，IMAP/SMTP + 应用专用密码）
 * @see ../../../docs/component-module.md
 *
 * 走 imap.gmail.com:993、smtp.gmail.com:587。
 * 应用专用密码保存在本机设置里，撤销前不用再授权。不走 Google Cloud，也不走 Workspace 开发者预览。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { callMcpTool, jsonOf, mcpNotReady, result, toolFailed } from '../../connect-lib.mjs'
import { pluginRoot } from '../../tools.mjs'
import { OFF, resolveNode, stdio } from '../shared.mjs'
import { normalizeAppPassword } from './password.mjs'

export const id = 'gmail'

export const app = { name: 'Gmail', exe: '—', match: /$^/ }

export const meta = {
  id: 'gmail',
  title: 'Gmail',
  group: '工作组件',
  url: 'https://support.google.com/accounts/answer/185833',
  serverName: 'gmail',
  summary: '用应用专用密码连接个人 Gmail（IMAP/SMTP），需要填写地址和应用专用密码。',
}

const SERVER = join(pluginRoot(), 'lib', 'gmail-server.mjs')

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'gmail',
  label: 'Gmail',
  url: 'https://support.google.com/accounts/answer/185833',
  serverName: 'gmail',
  summary: meta.summary,
  builtin: true,
  keys: ['gmailEnabled', 'gmailAddress', 'gmailAppPassword', 'nodePath'],
  installed() { return true },
  launch(cfg) {
    if (!cfg.gmailEnabled) return OFF
    const account = resolveAccount(cfg)
    if (!account) return { ok: false, reason: missingReason(cfg) }
    if (!existsSync(SERVER)) return { ok: false, reason: '插件里没有找到 Gmail 服务。请重新构建插件。' }
    const node = resolveNode(cfg)
    if (!node) return { ok: false, missing: true, reason: '未找到 Node.js 20.19+ / 22.12+。请在「通用 → Node.js」中安装。' }
    return {
      ok: true,
      source: 'managed',
      runtime: `Node ${node.version}，随插件提供`,
      config: stdio('gmail', node.path, [SERVER], {
        env: { ...node.env, GMAIL_ADDRESS: account.address, GMAIL_APP_PASSWORD: account.password },
      }),
    }
  },
  note(cfg) {
    const missing = resolveAccount(cfg) ? '' : missingReason(cfg) + ' '
    return `${missing}应用专用密码在 Google 撤销前不用再授权。send_message 会直接发信。`
  },
}

export async function probe(ctx) {
  const nr = mcpNotReady(ctx, this)
  if (nr) return nr
  const r = await callMcpTool(ctx.tools, this.serverName, 'status')
  if (!r.ok) return toolFailed(r, `Gmail 已挂载，但 status 失败：${r.error}`, 'tool:status')
  const body = jsonOf(r)
  const address = body?.address ? String(body.address) : ''
  return result('connected', address ? `Gmail 已挂载（${address}）` : 'Gmail 已挂载', 'tool:status')
}

function resolveAccount(cfg) {
  const address = String(cfg?.gmailAddress || '').trim()
  const password = normalizeAppPassword(cfg?.gmailAppPassword)
  if (address.includes('@') && password) return { address, password }
  return null
}

/** 地址或应用专用密码没填完整时的说明。旧版「留空时沿用本机已保存的邮箱」已移除。 */
export function missingReason(cfg) {
  const address = String(cfg?.gmailAddress || '').trim()
  const password = normalizeAppPassword(cfg?.gmailAppPassword)
  const lead = !address && !password ? '请填写 Gmail 地址和应用专用密码。'
    : !address.includes('@') ? '请填写有效的 Gmail 地址。'
    : '请填写该地址的 16 位应用专用密码。'
  return lead + '（旧版「地址和密码留空时沿用本机已保存的邮箱」已移除，需要在设置里填写一次。）'
}

export default component
