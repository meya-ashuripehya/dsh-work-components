/**
 * 从 Word / Excel / PowerPoint / PDF 里抽出卡片能显示的正文。
 * docx、xlsx、pptx 读 OOXML；doc、xls、ppt 只扫可读字符串；PDF 读文本对象。
 */
import { inflateRawSync } from 'node:zlib'
import { extname } from 'node:path'

const TEXT_LIMIT = 4000
const MAX_ROWS = 24
const MAX_COLS = 8
const MAX_SLIDES = 12
const MAX_SLIDE_LINES = 20

function clip(text) {
  const value = String(text ?? '').replace(/\u0000/g, '').trim()
  if (value.length <= TEXT_LIMIT) return value
  return value.slice(0, TEXT_LIMIT) + '\n…'
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function readZip(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const mark = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const eocd = data.lastIndexOf(mark)
  if (eocd < 0) return new Map()
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let i = 0; i < count && offset + 46 <= data.length; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) break
    const method = data.readUInt16LE(offset + 10)
    const compSize = data.readUInt32LE(offset + 20)
    const nameLen = data.readUInt16LE(offset + 28)
    const extraLen = data.readUInt16LE(offset + 30)
    const commentLen = data.readUInt16LE(offset + 32)
    const localOff = data.readUInt32LE(offset + 42)
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLen)
    if (localOff + 30 <= data.length) {
      const localNameLen = data.readUInt16LE(localOff + 26)
      const localExtraLen = data.readUInt16LE(localOff + 28)
      const start = localOff + 30 + localNameLen + localExtraLen
      const comp = data.subarray(start, start + compSize)
      try {
        const body = method === 0 ? comp : method === 8 ? inflateRawSync(comp) : null
        if (body) files.set(name, body)
      } catch { /* 单个条目坏了就跳过 */ }
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return files
}

function xmlParts(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)</' + tag + '>', 'g')
  const out = []
  let match
  while ((match = re.exec(xml))) out.push(decodeXml(match[1]))
  return out
}

function docxPreview(buf) {
  const xml = readZip(buf).get('word/document.xml')
  if (!xml) return { text: '' }
  const paragraphs = xml.toString('utf8').split(/<\/w:p>/)
  const lines = []
  for (const paragraph of paragraphs) {
    const line = xmlParts(paragraph, 'w:t').join('')
    if (line.trim()) lines.push(line)
  }
  return { text: clip(lines.join('\n')) }
}

function columnIndex(ref) {
  const letters = String(ref ?? '').replace(/[^A-Z]/gi, '').toUpperCase()
  let n = 0
  for (const char of letters) n = n * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, n - 1)
}

function rowIndex(ref) {
  const n = Number(String(ref ?? '').replace(/\D/g, ''))
  return Number.isInteger(n) && n > 0 ? n - 1 : 0
}

function sharedStrings(xml) {
  const out = []
  const pieces = String(xml ?? '').split(/<si[\s>]/).slice(1)
  for (const piece of pieces) {
    const end = piece.indexOf('</si>')
    out.push(xmlParts(end >= 0 ? piece.slice(0, end) : piece, 't').join(''))
  }
  return out
}

function sheetRows(xml, strings) {
  const rows = []
  const cells = String(xml ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)
  for (const cell of cells) {
    const attrs = cell[1]
    const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || ''
    const row = rowIndex(ref)
    const col = columnIndex(ref)
    if (row >= MAX_ROWS || col >= MAX_COLS) continue
    const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || ''
    const value = (cell[2].match(/<v[^>]*>([^<]*)<\/v>/) || [])[1]
    let text = ''
    if (type === 's') text = strings[Number(value)] || ''
    else if (type === 'inlineStr') text = xmlParts(cell[2], 't').join('')
    else if (value !== undefined) text = decodeXml(value)
    if (!rows[row]) rows[row] = []
    rows[row][col] = text
  }
  return rows
    .filter((row) => Array.isArray(row) && row.some((cell) => cell))
    .map((row) => {
      const cells = Array.from({ length: MAX_COLS }, (_, i) => row[i] || '')
      let end = cells.length
      while (end > 1 && !cells[end - 1]) end -= 1
      return cells.slice(0, end)
    })
}

function xlsxPreview(buf) {
  const zip = readZip(buf)
  const strings = sharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8'))
  const names = [...zip.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const blocks = []
  const lines = []
  for (const name of names.slice(0, 3)) {
    const rows = sheetRows(zip.get(name).toString('utf8'), strings)
    if (!rows.length) continue
    blocks.push(rows)
    const title = names.length > 1 ? '工作表 ' + name.match(/\d+/)[0] : ''
    if (title) lines.push(title)
    for (const row of rows) lines.push(row.join('\t'))
  }
  return { text: clip(lines.join('\n')), ...(blocks.length ? { rows: blocks[0] } : {}) }
}

function pptxPreview(buf) {
  const zip = readZip(buf)
  const names = [...zip.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const slides = []
  const lines = []
  for (const name of names.slice(0, MAX_SLIDES)) {
    const text = xmlParts(zip.get(name).toString('utf8'), 'a:t').map((line) => line.trim()).filter(Boolean).slice(0, MAX_SLIDE_LINES)
    if (!text.length) continue
    slides.push(text)
    lines.push('第 ' + (slides.length) + ' 页')
    lines.push(...text)
  }
  return { text: clip(lines.join('\n')), ...(slides.length ? { slides } : {}) }
}

function readableString(value) {
  const text = value.trim()
  if (text.length < 2) return ''
  let letters = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) letters += 1
  }
  if (!letters) return ''
  if (text.length >= 8 && letters / text.length < 0.3) return ''
  return text
}

function utf16Preview(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const lines = []
  let run = []
  const flush = () => {
    const text = readableString(run.join(''))
    if (text) lines.push(text)
    run = []
  }
  for (let i = 0; i + 1 < data.length; i += 2) {
    const code = data.readUInt16LE(i)
    if (code === 0x0d || code === 0x0a || code === 0x07 || code === 0x0b || code === 0x0c) {
      flush()
      continue
    }
    if (code >= 0x20 && code < 0xfffe) run.push(String.fromCharCode(code))
    else flush()
    if (run.length > 200) flush()
  }
  flush()
  return { text: clip(lines.join('\n')) }
}

function pdfUnescape(value) {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== '\\') { out += char; continue }
    const next = value[++i]
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === '(' || next === ')' || next === '\\') out += next
    else if (next >= '0' && next <= '7') {
      let oct = next
      for (let k = 0; k < 2 && value[i + 1] >= '0' && value[i + 1] <= '7'; k++) oct += value[++i]
      out += String.fromCharCode(parseInt(oct, 8))
    } else if (next !== undefined) out += next
  }
  return out
}

function pdfOperators(body) {
  const source = body.toString('latin1')
  const parts = []
  const push = (raw) => {
    const text = pdfUnescape(raw).replace(/\s+/g, ' ').trim()
    if (text) parts.push(text)
  }
  for (const match of source.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    push(match[0].slice(1, match[0].lastIndexOf(')')))
  }
  for (const match of source.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    for (const piece of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      push(piece[0].slice(1, -1))
    }
  }
  return parts.join(' ')
}

function pdfPreview(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const latin = data.toString('latin1')
  const parts = []
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g
  let match
  while ((match = re.exec(latin))) {
    const start = match.index + match[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) break
    let raw = data.subarray(start, end)
    if (raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1)
    if (raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1)
    let body = raw
    if (/FlateDecode/.test(match[1])) {
      try { body = inflateRawSync(raw) } catch { continue }
    }
    const text = pdfOperators(body)
    if (text) parts.push(text)
    if (parts.join('\n').length >= TEXT_LIMIT || start > 2_000_000) break
  }
  return { text: clip(parts.join('\n')) }
}

/** 抽出正文。没有对应格式时返回 null。 */
export function extractContentPreview(data, name) {
  const ext = extname(String(name ?? '')).toLowerCase()
  try {
    if (ext === '.docx') return docxPreview(data)
    if (ext === '.xlsx') return xlsxPreview(data)
    if (ext === '.pptx') return pptxPreview(data)
    if (ext === '.doc' || ext === '.xls' || ext === '.ppt') return utf16Preview(data)
    if (ext === '.pdf') return pdfPreview(data)
  } catch {
    return { text: '' }
  }
  return null
}
