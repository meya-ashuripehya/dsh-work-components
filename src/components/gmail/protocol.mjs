const MAX_LITERAL = 1_500_000

export class ByteQueue {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.queue = []
    this.ended = false
    this.error = null
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buf = this.buf.length ? Buffer.concat([this.buf, next]) : next
    this._drain()
  }

  end(error) {
    this.ended = true
    this.error = error || new Error('连接已关闭')
    this._drain()
  }

  readLine() { return this._wait(null) }

  readExact(n) { return this._wait(n) }

  _wait(n) {
    return new Promise((resolve, reject) => {
      this.queue.push({ n, resolve, reject })
      this._drain()
    })
  }

  _drain() {
    while (this.queue.length) {
      const job = this.queue[0]
      if (job.n == null) {
        const i = this.buf.indexOf(0x0a)
        if (i < 0) break
        let line = this.buf.subarray(0, i).toString('utf8')
        this.buf = this.buf.subarray(i + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        this.queue.shift()
        job.resolve(line)
      } else {
        if (this.buf.length < job.n) break
        const out = this.buf.subarray(0, job.n)
        this.buf = this.buf.subarray(job.n)
        this.queue.shift()
        job.resolve(out)
      }
    }
    if (this.ended && this.queue.length) {
      while (this.queue.length) this.queue.shift().reject(this.error)
    }
  }
}

export function bufferIo(transcript) {
  const queue = new ByteQueue()
  queue.push(transcript)
  const writes = []
  return {
    writes,
    readLine: () => queue.readLine(),
    readExact: (n) => queue.readExact(n),
    write(chunk) { writes.push(String(chunk)) },
    async startTls() { return this },
    close() {},
  }
}

export function imapQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export async function readImapLine(io) {
  let line = await io.readLine()
  const literals = []
  while (true) {
    const m = /\{(\d+)\}$/.exec(line)
    if (!m) return { line, literals }
    const n = Number(m[1])
    if (n > MAX_LITERAL) throw new Error('邮件过大，已中止读取')
    literals.push(await io.readExact(n))
    line = line.slice(0, m.index) + await io.readLine()
  }
}

export function explainImap(line) {
  if (/disabled|not enabled for imap|imap is disabled/i.test(line)) {
    return 'Gmail 没有打开 IMAP。请到 Gmail 网页「设置 → 转发和 POP/IMAP」里启用 IMAP。'
  }
  if (/AUTHENTICAT|Invalid credentials|Application-specific|Web login required/i.test(line)) {
    return 'Gmail 拒绝了这个密码。请使用 16 位应用专用密码，不能用 Gmail 登录密码。刚生成的密码等一两分钟再试。'
  }
  return String(line).replace(/^[a-zA-Z0-9]+\s+(NO|BAD)\s*/i, '').trim() || 'Gmail 返回了错误'
}

export function explainSmtp(line) {
  if (/535|534|Username and Password not accepted|Application-specific|Web login required/i.test(line)) {
    return 'Gmail 拒绝了这个密码。请使用 16 位应用专用密码，不能用 Gmail 登录密码。刚生成的密码等一两分钟再试。'
  }
  return String(line).trim() || 'Gmail 返回了错误'
}

export async function imapSession(io, address, password, run) {
  await readImapLine(io)
  let seq = 0
  async function command(...parts) {
    const tag = 'a' + String(++seq).padStart(3, '0')
    io.write(tag + ' ' + parts.join(' ') + '\r\n')
    const messages = []
    while (true) {
      const msg = await readImapLine(io)
      if (msg.line.startsWith(tag + ' ')) {
        if (!msg.line.startsWith(tag + ' OK')) throw new Error(explainImap(msg.line))
        return messages
      }
      messages.push(msg)
    }
  }
  await command('LOGIN', imapQuote(address), imapQuote(password))
  try {
    return await run(command)
  } finally {
    try { await command('LOGOUT') } catch { /* 连接已经断了 */ }
    try { io.close() } catch { /* 忽略 */ }
  }
}

export function searchUids(messages) {
  const uids = []
  for (const msg of messages) {
    const m = /^\* SEARCH\s*(.*)$/.exec(msg.line)
    if (!m || !m[1].trim()) continue
    for (const part of m[1].trim().split(/\s+/)) {
      const n = Number(part)
      if (Number.isInteger(n)) uids.push(n)
    }
  }
  return uids
}

export function parseFetch(messages) {
  const rows = []
  for (const msg of messages) {
    if (!/^\* \d+ FETCH /.test(msg.line)) continue
    rows.push({
      uid: Number(/UID (\d+)/.exec(msg.line)?.[1]),
      flags: /FLAGS \(([^)]*)\)/.exec(msg.line)?.[1] || '',
      literals: msg.literals,
    })
  }
  return rows.filter((row) => Number.isInteger(row.uid))
}

export async function readSmtpReply(io) {
  let last = await io.readLine()
  let all = last
  while (/^\d{3}-/.test(last)) {
    last = await io.readLine()
    all += '\n' + last
  }
  return { code: Number(last.slice(0, 3)), line: all }
}

export function buildMessage({ address, to, cc, subject, text }) {
  const headers = [
    `From: ${address}`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean)
  const body = String(text).replace(/\r?\n/g, '\r\n').split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n')
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.\r\n'
}

async function expectSmtp(io, code) {
  const reply = await readSmtpReply(io)
  if (reply.code !== code) throw new Error(explainSmtp(reply.line))
}

export async function smtpSend(io, { address, password, to, cc, subject, text }) {
  await expectSmtp(io, 220)
  io.write('EHLO dsh-work-components\r\n')
  await expectSmtp(io, 250)
  io.write('STARTTLS\r\n')
  await expectSmtp(io, 220)
  io = await io.startTls()
  io.write('EHLO dsh-work-components\r\n')
  await expectSmtp(io, 250)
  io.write('AUTH LOGIN\r\n')
  await expectSmtp(io, 334)
  io.write(Buffer.from(address).toString('base64') + '\r\n')
  await expectSmtp(io, 334)
  io.write(Buffer.from(password).toString('base64') + '\r\n')
  await expectSmtp(io, 235)
  io.write(`MAIL FROM:<${address}>\r\n`)
  await expectSmtp(io, 250)
  for (const rcpt of [...to, ...cc]) {
    io.write(`RCPT TO:<${rcpt}>\r\n`)
    await expectSmtp(io, 250)
  }
  io.write('DATA\r\n')
  await expectSmtp(io, 354)
  io.write(buildMessage({ address, to, cc, subject, text }))
  await expectSmtp(io, 250)
  io.write('QUIT\r\n')
  try { io.close() } catch { /* 忽略 */ }
}
