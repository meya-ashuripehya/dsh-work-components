/**
 * 「多模态 › 视频理解」凭据：API Key（videoGeminiKey）或 Google Cloud 服务账号 JSON（Vertex）。
 * 密钥 / 私钥只放在请求头；状态接口只返回来源与掩码信息。
 */
import { dataDir } from '../tools.mjs'
import {
  readServiceAccountMeta,
  SA_FILE_PROBLEM,
  serviceAccountAbsPath,
  videoCredentialSource,
  videoVertexLocation,
  videoAuthReady,
} from './credential.mjs'

export { videoAuthReady }

export const VIDEO_KEY_SETTING = 'videoGeminiKey'
export const VIDEO_KEY_MISSING = '未配置密钥：请在「多模态 › 视频理解」中填写 Gemini API 密钥。'

const clean = (v) => (typeof v === 'string' ? v.trim() : '')

/** → 凭据解析结果；serviceAccount 模式下忽略 videoGeminiKey。 */
export function resolveVideoKey(cfg, root = dataDir()) {
  if (videoCredentialSource(cfg) === 'serviceAccount') {
    const meta = readServiceAccountMeta(cfg, root)
    if (!meta.ok) {
      return { key: '', credentialSource: 'serviceAccount', problem: meta.problem || SA_FILE_PROBLEM }
    }
    const { rel } = serviceAccountAbsPath(cfg, root)
    return {
      key: '',
      credentialSource: 'serviceAccount',
      ref: 'videoServiceAccountFile',
      via: 'component',
      keyPath: rel,
      projectId: meta.projectId,
      clientEmail: meta.clientEmail,
      location: videoVertexLocation(cfg),
    }
  }
  const key = clean(cfg?.[VIDEO_KEY_SETTING])
  return key
    ? { key, credentialSource: 'apiKey', ref: VIDEO_KEY_SETTING, via: 'component' }
    : { key: '', credentialSource: 'apiKey', problem: VIDEO_KEY_MISSING }
}

/** 掩码：只露末四位（太短时全遮）。 */
export function maskTail(key) {
  const k = clean(key)
  if (!k) return ''
  return k.length >= 12 ? '••••' + k.slice(-4) : '••••'
}

/** 设置页状态：含 credentialSource；不含密钥或私钥。 */
export function videoKeyStatus(cfg, { root = dataDir() } = {}) {
  const source = videoCredentialSource(cfg)
  if (source === 'serviceAccount') {
    const meta = readServiceAccountMeta(cfg, root)
    if (!meta.ok) {
      return { ready: false, credentialSource: 'serviceAccount', problem: meta.problem || SA_FILE_PROBLEM }
    }
    return {
      ready: true,
      credentialSource: 'serviceAccount',
      clientEmail: meta.clientEmail,
      projectId: meta.projectId,
      file: meta.relPath,
    }
  }
  const key = clean(cfg?.[VIDEO_KEY_SETTING])
  return key
    ? { ready: true, credentialSource: 'apiKey', source: '组件设置', tail: maskTail(key) }
    : { ready: false, credentialSource: 'apiKey', problem: VIDEO_KEY_MISSING }
}
