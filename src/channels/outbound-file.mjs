/**
 * 主动出站的文件部分，与 channel-harness 转发 mm_send_file 的形状相同：
 * adapter.send(target, { text?, parts: [{ type: 'file', localData, name, mimeType }] })。
 * Telegram 由此走 sendDocument；QQ 走官方 FILE 上传。不另写一套传输。
 */

export function buildChannelMessage(payload = {}) {
  const text = String(payload?.text ?? '')
  const file = payload?.file
  const message = {}
  if (text.trim()) message.text = text
  if (file && file.localData != null) {
    message.parts = [{
      type: 'file',
      localData: file.localData,
      name: String(file.name || 'file'),
      mimeType: String(file.mimeType || 'application/octet-stream'),
    }]
  }
  return message
}

export function channelMessageIsEmpty(message) {
  return !message?.text && !message?.parts?.length
}
