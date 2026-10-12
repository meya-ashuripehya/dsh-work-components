import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageText } from './mime.mjs'
import { listMessages, readMessage, sendMessage } from './mail.mjs'
import { encodeSubject, normalizeAppPassword, parseAddressList } from './password.mjs'
import { bufferIo, explainImap } from './protocol.mjs'
import { createDispatch, handleMessage } from './rpc.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openRelaySecret, readLegacyGmail, sealRelaySecret } from './legacy.mjs'
import { component } from './index.mjs'

const PASSWORD = 'abcd efgh ijkl mnop'

test('app password keeps the 16 letters and drops spaces', () => {
  assert.equal(normalizeAppPassword('abcd efgh ijkl mnop'), 'abcdefghijklmnop')
  assert.equal(normalizeAppPassword('  abcd\n'), 'abcd')
})

test('subject and addresses reject header injection', () => {
  assert.equal(encodeSubject('你好'), '=?UTF-8?B?5L2g5aW9?=')
  assert.throws(() => encodeSubject('hi\nBcc: x@y.z'), /换行/)
  assert.deepEqual(parseAddressList('a@b.com, c@d.com', '收件人'), ['a@b.com', 'c@d.com'])
  assert.throws(() => parseAddressList('a@b.com\nBcc: x@y.z', '收件人'), /无法识别/)
})

test('mime prefers the plain part and decodes quoted-printable html', () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'plain line',
    '--b',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>=E4=BD=A0=E5=A5=BD</p>',
    '--b--',
    '',
  ].join('\r\n')
  assert.equal(messageText(raw), 'plain line')
  const htmlOnly = [
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>=E4=BD=A0=E5=A5=BD</p>',
  ].join('\r\n')
  assert.equal(messageText(htmlOnly), '你好')
})

function literal(prefix, body, suffix) {
  const bytes = Buffer.from(body, 'utf8')
  return Buffer.concat([
    Buffer.from(`${prefix}{${bytes.length}}\r\n`),
    bytes,
    Buffer.from(suffix),
  ])
}

test('list and read use inbox search without putting the password in the result', async () => {
  const header = 'From: Ann <ann@example.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\n\r\n'
  const listIo = bufferIo(Buffer.concat([
    Buffer.from('* OK\r\na001 OK LOGIN\r\na002 OK SELECT\r\n* SEARCH 5 9\r\na003 OK SEARCH\r\n'),
    literal('* 1 FETCH (UID 9 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE)] ', header, ')\r\n'),
    Buffer.from('a004 OK FETCH\r\na005 OK LOGOUT\r\n'),
  ]))
  const deps = {
    address: 'me@gmail.com',
    password: 'abcdefghijklmnop',
    connectImap: async () => listIo,
  }
  const rows = await listMessages(deps, { query: 'newer_than:2d', limit: 5 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uid, 9)
  assert.equal(rows[0].subject, '你好')
  assert.equal(rows[0].seen, true)
  assert.match(listIo.writes.join(''), /X-GM-RAW "newer_than:2d"/)
  assert.equal(listIo.writes.join('').includes('abcdefghijklmnop'), true)

  const raw = 'From: Ann <ann@example.com>\r\nSubject: Hi\r\n\r\nhello body\r\n'
  const readIo = bufferIo(Buffer.concat([
    Buffer.from('* OK\r\na001 OK LOGIN\r\na002 OK SELECT\r\n'),
    literal('* 1 FETCH (UID 9 FLAGS () BODY[] ', raw, ')\r\n'),
    Buffer.from('a003 OK FETCH\r\na004 OK LOGOUT\r\n'),
  ]))
  const mail = await readMessage({ ...deps, connectImap: async () => readIo }, 9)
  assert.equal(mail.text, 'hello body')
  assert.equal(explainImap('a001 NO [AUTHENTICATIONFAILED] Invalid credentials'), 'Gmail 拒绝了这个密码。请使用 16 位应用专用密码，不能用 Gmail 登录密码。刚生成的密码等一两分钟再试。')
})

test('send writes a real message and the tool text does not echo the password', async () => {
  const smtp = [
    '220 ready',
    '250-smtp.gmail.com',
    '250 AUTH',
    '220 TLS',
    '250 AUTH',
    '334 user',
    '334 pass',
    '235 ok',
    '250 from',
    '250 rcpt',
    '250 cc',
    '354 go',
    '250 queued',
  ].join('\r\n') + '\r\n'
  const io = bufferIo(smtp)
  const deps = {
    address: 'me@gmail.com',
    password: 'abcdefghijklmnop',
    connectSmtp: async () => io,
  }
  const dispatch = createDispatch(deps)
  const out = await handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'send_message', arguments: { to: 'a@b.com', cc: 'c@d.com', subject: '你好', text: 'hello\n.secret' } },
  }, dispatch)
  assert.equal(out.result.isError, undefined)
  assert.match(out.result.content[0].text, /已发送给 a@b.com/)
  assert.equal(out.result.content[0].text.includes('abcdefghijklmnop'), false)
  const data = io.writes.join('')
  assert.match(data, /Subject: =\?UTF-8\?B\?/)
  assert.match(data, /\r\n\.\.secret\r\n/)
  assert.match(data, /RCPT TO:<c@d.com>/)
})

test('launch keeps the app password out of the failure text and out of argv', () => {
  const secret = 'abcd efgh ijkl mnop'
  const off = component.launch({ gmailEnabled: false, gmailAddress: 'a@gmail.com', gmailAppPassword: secret })
  assert.equal(off.ok, false)
  const plan = component.launch({ gmailEnabled: true, gmailAddress: 'a@gmail.com', gmailAppPassword: secret })
  const dumped = JSON.stringify(plan)
  if (!plan.ok) {
    assert.equal(dumped.includes('abcdefghijklmnop'), false)
    assert.equal(dumped.includes(secret), false)
  } else {
    assert.equal(plan.config.env.GMAIL_APP_PASSWORD, 'abcdefghijklmnop')
    assert.equal(plan.config.args.some((arg) => String(arg).includes('abcdefghijklmnop')), false)
  }
  const other = component.launch({ gmailEnabled: true, gmailAddress: 'other@gmail.com', gmailAppPassword: '' })
  assert.equal(other.ok, false)
  assert.match(other.reason, /没有可用的 Gmail/)
})

test('empty settings reuse the Gmail already saved by TRIX mail', () => {
  const plan = component.launch({ gmailEnabled: true, gmailAddress: '', gmailAppPassword: '' })
  if (!plan.ok) return
  assert.equal(plan.config.env.GMAIL_ADDRESS.endsWith('@gmail.com'), true)
  const saved = plan.config.env.GMAIL_APP_PASSWORD
  assert.equal(saved.length, 16)
  assert.equal(/^[A-Za-z]+$/.test(saved), true)
  assert.equal(plan.config.args.some((arg) => String(arg).includes(saved)), false)
})

test('relay secret roundtrip and a temporary mail database', () => {
  const secret = 'abcdefghijklmnop'
  const sealed = sealRelaySecret(secret, 'trix-mail-relay-dev-key')
  assert.equal(openRelaySecret(sealed, 'trix-mail-relay-dev-key'), secret)
  assert.notEqual(openRelaySecret(sealed, 'other-key'), secret)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gmail-'))
  const file = join(dir, 'mail.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE mail_relay_config (
    id INTEGER PRIMARY KEY, provider TEXT, email TEXT, auth_secret_enc TEXT
  )`)
  db.prepare('INSERT INTO mail_relay_config (id, provider, email, auth_secret_enc) VALUES (1, ?, ?, ?)')
    .run('gmail', 'saved@gmail.com', sealed)
  db.close()
  const found = readLegacyGmail([file])
  assert.equal(found.address, 'saved@gmail.com')
  assert.equal(found.password, secret)
  rmSync(dir, { recursive: true, force: true })
})

test('send rejects an empty body before opening a connection', async () => {
  let opened = false
  await assert.rejects(sendMessage({
    address: 'me@gmail.com',
    password: 'x',
    connectSmtp: async () => { opened = true },
  }, { to: 'a@b.com', subject: 's', text: '  ' }), /正文/)
  assert.equal(opened, false)
})
