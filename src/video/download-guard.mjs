/**
 * 服务账号 + 无桶：下载前根据 yt-dlp 元数据拦截 >20 MB（避免白下）。
 */
import { SA_INLINE_MAX_BYTES } from './credential.mjs'

export const SA_NO_BUCKET_ERROR = '服务账号模式未配置存储桶，只支持 20 MB 以内的视频。请改用 API Key 模式，或在设置里填写存储桶。'

const ESTIMATE_BPS = 1.5 * 1024 * 1024 / 8 // 1.5 Mbps

export function estimateBytesFromDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  return Math.ceil(s * ESTIMATE_BPS)
}

function pickFormatSize(f) {
  if (!f || typeof f !== 'object') return 0
  const a = Number(f.filesize)
  if (Number.isFinite(a) && a > 0) return a
  const b = Number(f.filesize_approx)
  if (Number.isFinite(b) && b > 0) return b
  return 0
}

/** @param {object} info yt-dlp -J 输出 */
export function assessRemoteVideoSize(info, { maxBytes = SA_INLINE_MAX_BYTES } = {}) {
  const formats = Array.isArray(info?.formats) ? info.formats : []
  let best = 0
  for (const f of formats) best = Math.max(best, pickFormatSize(f))
  if (best > maxBytes) return { ok: false, reason: SA_NO_BUCKET_ERROR, bytes: best, source: 'filesize' }
  const dur = Number(info?.duration)
  if (best <= 0 && Number.isFinite(dur) && dur > 0) {
    const est = estimateBytesFromDuration(dur)
    if (est > maxBytes) return { ok: false, reason: SA_NO_BUCKET_ERROR, bytes: est, source: 'duration' }
    return { ok: true, bytes: est, source: 'estimate' }
  }
  if (best > 0) return { ok: true, bytes: best, source: 'filesize' }
  return { ok: true, bytes: 0, source: 'unknown' }
}

export function ytdlpMaxFilesizeArg(hasBucket) {
  if (hasBucket) return null
  return '20M'
}

export function sessionDownloadMaxBytes({ credentialSource, hasBucket, apiKeyMax, saNoBucketMax = SA_INLINE_MAX_BYTES }) {
  if (credentialSource !== 'serviceAccount') return apiKeyMax
  if (hasBucket) return apiKeyMax
  return saNoBucketMax
}
