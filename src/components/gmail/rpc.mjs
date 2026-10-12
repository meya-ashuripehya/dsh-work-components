import { listMessages, readMessage, sendMessage } from './mail.mjs'

const TOOLS = [
  {
    name: 'status',
    description: '查看已保存的 Gmail 地址。不连网，也不返回密码。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_messages',
    description: '列出收件箱邮件。query 使用 Gmail 搜索语法，例如 newer_than:7d、is:unread、from:alice@example.com。默认 newer_than:14d。返回 uid、发件人、主题和日期。读正文用 read_message。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail 搜索语法。留空则 newer_than:14d。' },
        limit: { type: 'integer', description: '最多返回多少封，1 到 20，默认 10。' },
      },
    },
  },
  {
    name: 'read_message',
    description: '按 uid 读取收件箱里一封邮件的纯文本正文。uid 来自 list_messages。',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'integer', description: 'list_messages 返回的 uid。' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'send_message',
    description: '用已保存的 Gmail 地址立即发信，不是草稿。收件人会真的收到。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人。多个地址用逗号分隔。' },
        cc: { type: 'string', description: '抄送，可空。' },
        subject: { type: 'string', description: '主题。' },
        text: { type: 'string', description: '纯文本正文。' },
      },
      required: ['to', 'subject', 'text'],
    },
  },
]

export function createDispatch(deps) {
  return async function dispatch(msg) {
    const method = msg.method
    const params = msg.params || {}
    if (method === 'initialize') {
      return {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gmail', version: '1.0.0' },
      }
    }
    if (method === 'ping') return {}
    if (method === 'resources/list') return { resources: [] }
    if (method === 'prompts/list') return { prompts: [] }
    if (method === 'tools/list') return { tools: TOOLS }
    if (method === 'tools/call') return callTool(deps, params)
    if (String(method || '').startsWith('notifications/')) return null
    throw new Error(`不支持的方法 ${method}`)
  }
}

async function callTool(deps, params) {
  try {
    const name = params.name
    const args = params.arguments || {}
    if (name === 'status') return text(JSON.stringify({ address: deps.address }))
    if (name === 'list_messages') {
      const rows = await listMessages(deps, args)
      if (!rows.length) return text('收件箱里没有符合条件的邮件。')
      return text(JSON.stringify(rows, null, 2))
    }
    if (name === 'read_message') {
      const mail = await readMessage(deps, args.uid)
      const lines = [
        `uid: ${mail.uid}`,
        `from: ${mail.from}`,
        `to: ${mail.to}`,
        mail.cc ? `cc: ${mail.cc}` : '',
        `subject: ${mail.subject}`,
        `date: ${mail.date}`,
        '',
        mail.text || '（没有可显示的正文）',
      ].filter((line) => line !== '')
      return text(lines.join('\n'))
    }
    if (name === 'send_message') {
      const sent = await sendMessage(deps, args)
      const cc = sent.cc.length ? `，抄送 ${sent.cc.join(', ')}` : ''
      return text(`已发送给 ${sent.to.join(', ')}${cc}。主题：${sent.subject}`)
    }
    throw new Error(`没有这个工具：${name}`)
  } catch (error) {
    return { content: [{ type: 'text', text: error?.message || String(error) }], isError: true }
  }
}

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

export async function handleMessage(msg, dispatch) {
  if (!msg || typeof msg !== 'object' || msg.id == null) {
    if (msg?.method) await dispatch(msg).catch(() => {})
    return null
  }
  try {
    const result = await dispatch(msg)
    if (result == null && String(msg.method || '').startsWith('notifications/')) return null
    return { jsonrpc: '2.0', id: msg.id, result }
  } catch (error) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: error?.message || String(error) } }
  }
}

export function runStdio(dispatch) {
  let buf = ''
  let chain = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      chain = chain.then(() => handleMessage(msg, dispatch)).then((out) => {
        if (out) process.stdout.write(JSON.stringify(out) + '\n')
      }).catch((error) => {
        process.stderr.write(String(error?.message || error) + '\n')
      })
    }
  })
}
