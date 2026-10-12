/**
 * 读取本机 TRIX 邮件已经保存的 Gmail。
 * 库在 ATRI-INFRA/mail-gateway/data/mail.db，密文算法与 mail-gateway/store/relay.py 相同。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pluginRoot } from '../../tools.mjs'
import { normalizeAppPassword } from './password.mjs'

const DEV_KEY = 'trix-mail-relay-dev-key'
const COMPOSE_DEFAULT = 'workerTokenMail2026Secret'

export function sealRelaySecret(plain, seed) {
  const key = createHash('sha256').update(String(seed)).digest()
  const data = Buffer.from(String(plain), 'utf8')
  const enc = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) enc[i] = data[i] ^ key[i % key.length]
  return 'v1:' + enc.toString('base64url')
}

export function openRelaySecret(stored, seed) {
  if (!stored || !String(stored).startsWith('v1:')) return ''
  const key = createHash('sha256').update(String(seed)).digest()
  let raw
  try { raw = Buffer.from(String(stored).slice(3), 'base64url') } catch { return '' }
  const plain = Buffer.alloc(raw.length)
  for (let i = 0; i < raw.length; i++) plain[i] = raw[i] ^ key[i % key.length]
  const text = plain.toString('utf8')
  if (text.includes('\uFFFD')) return ''
  return normalizeAppPassword(text)
}

function plausible(password) {
  return /^[A-Za-z]{16}$/.test(password) ? password : ''
}

function envValue(text, key) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith(key + '=')) continue
    return trimmed.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

function seedsFor(dbFile) {
  const seeds = []
  const push = (value) => { if (value && !seeds.includes(value)) seeds.push(value) }
  push(process.env.MAIL_RELAY_ENC_KEY)
  push(process.env.MAIL_WORKER_TOKEN)
  const dir = dirname(dbFile)
  const files = [
    join(dir, '..', '..', '.env'),
    join(dir, '..', '..', '..', 'ATRI-MAIN', 'mail.env'),
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    push(envValue(text, 'MAIL_RELAY_ENC_KEY'))
    push(envValue(text, 'MAIL_WORKER_TOKEN'))
  }
  push(DEV_KEY)
  push(COMPOSE_DEFAULT)
  return seeds
}

export function legacyMailDbCandidates() {
  const root = pluginRoot()
  return [
    process.env.MAIL_GATEWAY_DB || '',
    join(root, '..', 'ATRI-INFRA', 'mail-gateway', 'data', 'mail.db'),
  ].filter(Boolean)
}

export function readLegacyGmail(files = legacyMailDbCandidates()) {
  for (const file of files) {
    const found = readOne(file)
    if (found) return found
  }
  return null
}

function readOne(file) {
  if (!file || !existsSync(file)) return null
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare(
      'SELECT provider, email, auth_secret_enc FROM mail_relay_config WHERE id = 1',
    ).get()
    if (!row || row.provider !== 'gmail') return null
    const address = String(row.email || '').trim()
    if (!address.includes('@')) return null
    for (const seed of seedsFor(file)) {
      const password = plausible(openRelaySecret(row.auth_secret_enc, seed))
      if (password) return { address, password }
    }
    return null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* 忽略 */ }
  }
}
