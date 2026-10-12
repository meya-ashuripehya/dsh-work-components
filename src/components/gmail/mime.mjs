export function parseHeaders(raw) {
  const text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const map = new Map()
  let name = ''
  let value = ''
  const flush = () => {
    if (name) map.set(name.toLowerCase(), value.trim())
    name = ''
    value = ''
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (/^[ \t]/.test(line) && name) {
      value += ' ' + line.trim()
      continue
    }
    flush()
    const i = line.indexOf(':')
    if (i < 0) continue
    name = line.slice(0, i).trim()
    value = line.slice(i + 1).trim()
  }
  flush()
  return map
}

export function decodeHeaderWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64')
      : decodeQuotedPrintable(data.replace(/_/g, ' '))
    return decodeCharset(bytes, charset)
  })
}

export function decodeQuotedPrintable(text) {
  const stripped = String(text).replace(/=\r?\n/g, '')
  const bytes = []
  for (let i = 0; i < stripped.length; i++) {
    const hex = stripped.slice(i + 1, i + 3)
    if (stripped[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else {
      bytes.push(stripped.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

function decodeCharset(buf, charset) {
  const name = String(charset || 'utf-8').toLowerCase()
  if (name === 'utf-8' || name === 'utf8' || name === 'us-ascii') return buf.toString('utf8')
  if (name === 'iso-8859-1' || name === 'latin1') return buf.toString('latin1')
  try { return new TextDecoder(name).decode(buf) } catch { return buf.toString('utf8') }
}

function asLatin1(raw) {
  return Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw)
}

function splitHead(raw) {
  const text = asLatin1(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const idx = text.indexOf('\n\n')
  const head = idx < 0 ? text : text.slice(0, idx)
  const body = idx < 0 ? '' : text.slice(idx + 2)
  return { headers: parseHeaders(head), body }
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding || '').toLowerCase()
  if (enc.includes('base64')) return Buffer.from(body.replace(/\s+/g, ''), 'base64')
  if (enc.includes('quoted-printable')) return decodeQuotedPrintable(body)
  return Buffer.from(body, 'latin1')
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function messageText(raw, depth = 0) {
  if (depth > 6) return ''
  const { headers, body } = splitHead(raw)
  const type = headers.get('content-type') || 'text/plain'
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1]
  if (boundary && /multipart\//i.test(type)) {
    let plain = ''
    let html = ''
    for (const chunk of body.split('--' + boundary)) {
      const part = chunk.replace(/^\n/, '')
      if (!part.trim() || part.trim() === '--') continue
      const subType = splitHead(part).headers.get('content-type') || ''
      const text = messageText(part, depth + 1)
      if (/text\/plain/i.test(subType) && !plain) plain = text
      else if (/text\/html/i.test(subType) && !html) html = text
      else if (/multipart\//i.test(subType) && !plain) plain = text
    }
    return (plain || html).trim()
  }
  const decoded = decodeCharset(decodeTransfer(body, headers.get('content-transfer-encoding')), charsetOf(type))
  if (/text\/html/i.test(type)) return stripHtml(decoded)
  return decoded.trim()
}

function charsetOf(type) {
  return /charset="?([^";]+)"?/i.exec(type)?.[1] || 'utf-8'
}
