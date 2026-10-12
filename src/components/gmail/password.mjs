/** Gmail 应用专用密码粘贴时常常带空格（abcd efgh ijkl mnop）。 */
export function normalizeAppPassword(value) {
  return String(value || '').replace(/\s+/g, '')
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export function parseAddressList(value, label) {
  const parts = String(value || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error(`请填写${label}`)
  if (parts.length > 10) throw new Error(`${label}最多 10 个`)
  for (const part of parts) {
    if (/[\r\n]/.test(part) || !EMAIL.test(part)) {
      const shown = part.length > 80 ? part.slice(0, 80) + '…' : part
      throw new Error(`${label}里有无法识别的地址：${shown}`)
    }
  }
  return parts
}

export function encodeSubject(subject) {
  const text = String(subject ?? '')
  if (/[\r\n]/.test(text)) throw new Error('主题不能换行')
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}
