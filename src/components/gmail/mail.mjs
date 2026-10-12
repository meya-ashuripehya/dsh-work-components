import net from 'node:net'
import tls from 'node:tls'
import { decodeHeaderWords, messageText, parseHeaders } from './mime.mjs'
import { encodeSubject, parseAddressList } from './password.mjs'
import { ByteQueue, imapQuote, imapSession, parseFetch, searchUids, smtpSend } from './protocol.mjs'

const IMAP_HOST = 'imap.gmail.com'
const SMTP_HOST = 'smtp.gmail.com'
const TEXT_LIMIT = 16000

function clip(text) {
  const value = String(text || '')
  if (value.length <= TEXT_LIMIT) return value
  return value.slice(0, TEXT_LIMIT) + '\n…（正文已截断）'
}

function netError(error, host) {
  const msg = String(error?.message || error)
  if (/邮件过大|没有打开 IMAP|拒绝了这个密码/.test(msg)) throw error
  if (/timeout|ETIMEDOUT|超时/i.test(msg)) throw new Error(`连接 ${host} 超时。请检查网络后重试。`)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|certificate|CERT/i.test(msg)) {
    throw new Error(`连不上 ${host}。请检查网络后重试。`)
  }
  throw error
}

function attach(socket) {
  const queue = new ByteQueue()
  const onData = (chunk) => queue.push(chunk)
  const onError = (error) => queue.end(error)
  const onClose = () => queue.end()
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)
  return {
    readLine: () => queue.readLine(),
    readExact: (n) => queue.readExact(n),
    write(chunk) { socket.write(chunk) },
    detach() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    },
    close() { socket.end() },
  }
}

export function connectImap() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: IMAP_HOST, port: 993, servername: IMAP_HOST })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${IMAP_HOST} 超时。请检查网络后重试。`))
    }, 20000)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      socket.setTimeout(30000, () => socket.destroy(new Error(`连接 ${IMAP_HOST} 超时。请检查网络后重试。`)))
      resolve(attach(socket))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export function connectSmtp() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(587, SMTP_HOST)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${SMTP_HOST} 超时。请检查网络后重试。`))
    }, 20000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setTimeout(30000, () => socket.destroy(new Error(`连接 ${SMTP_HOST} 超时。请检查网络后重试。`)))
      const plain = attach(socket)
      plain.startTls = () => new Promise((res, rej) => {
        plain.detach()
        const secure = tls.connect({ socket, servername: SMTP_HOST })
        secure.once('secureConnect', () => res(attach(secure)))
        secure.once('error', rej)
      })
      resolve(plain)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function summary(row) {
  const headers = parseHeaders((row.literals[0] || Buffer.alloc(0)).toString('latin1'))
  return {
    uid: row.uid,
    seen: /\\Seen\b/.test(row.flags),
    from: decodeHeaderWords(headers.get('from') || ''),
    to: decodeHeaderWords(headers.get('to') || ''),
    subject: decodeHeaderWords(headers.get('subject') || ''),
    date: headers.get('date') || '',
  }
}

function clampLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return 10
  return Math.min(20, Math.max(1, Math.floor(n)))
}

export async function listMessages(deps, { query, limit } = {}) {
  const q = String(query || '').trim() || 'newer_than:14d'
  const n = clampLimit(limit)
  let io
  try {
    io = await deps.connectImap()
  } catch (error) {
    netError(error, IMAP_HOST)
  }
  try {
    return await imapSession(io, deps.address, deps.password, async (command) => {
      await command('SELECT', imapQuote('INBOX'))
      const searched = await command('UID SEARCH', 'X-GM-RAW', imapQuote(q))
      const uids = searchUids(searched).slice(-n)
      if (!uids.length) return []
      const fetched = await command(
        'UID FETCH',
        uids.join(','),
        '(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE)])',
      )
      return parseFetch(fetched).map(summary).reverse()
    })
  } catch (error) {
    netError(error, IMAP_HOST)
  }
}

export async function readMessage(deps, uid) {
  const id = Number(uid)
  if (!Number.isInteger(id) || id <= 0) throw new Error('uid 必须是 list_messages 返回的正整数')
  let io
  try {
    io = await deps.connectImap()
  } catch (error) {
    netError(error, IMAP_HOST)
  }
  try {
    return await imapSession(io, deps.address, deps.password, async (command) => {
      await command('SELECT', imapQuote('INBOX'))
      const fetched = await command('UID FETCH', String(id), '(UID FLAGS BODY.PEEK[])')
      const row = parseFetch(fetched)[0]
      if (!row?.literals?.[0]) throw new Error('收件箱里没有这封邮件')
      const raw = row.literals[0]
      const headers = parseHeaders(raw.toString('latin1'))
      return {
        uid: row.uid,
        seen: /\\Seen\b/.test(row.flags),
        from: decodeHeaderWords(headers.get('from') || ''),
        to: decodeHeaderWords(headers.get('to') || ''),
        cc: decodeHeaderWords(headers.get('cc') || ''),
        subject: decodeHeaderWords(headers.get('subject') || ''),
        date: headers.get('date') || '',
        text: clip(messageText(raw)),
      }
    })
  } catch (error) {
    netError(error, IMAP_HOST)
  }
}

export async function sendMessage(deps, { to, cc, subject, text } = {}) {
  const recipients = parseAddressList(to, '收件人')
  const copies = String(cc || '').trim() ? parseAddressList(cc, '抄送') : []
  const title = String(subject ?? '')
  if (!title.trim()) throw new Error('请填写主题')
  const body = String(text ?? '')
  if (!body.trim()) throw new Error('请填写正文')
  const encoded = encodeSubject(title)
  let io
  try {
    io = await deps.connectSmtp()
  } catch (error) {
    netError(error, SMTP_HOST)
  }
  try {
    await smtpSend(io, {
      address: deps.address,
      password: deps.password,
      to: recipients,
      cc: copies,
      subject: encoded,
      text: body,
    })
  } catch (error) {
    try { io.close() } catch { /* 忽略 */ }
    netError(error, SMTP_HOST)
  }
  return { to: recipients, cc: copies, subject: title }
}
