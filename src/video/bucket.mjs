/**
 * Vertex 服务账号模式：大视频经 Cloud Storage 桶引用（gs://）。
 * 删除仅允许 `{prefix}/{taskId}/` 下对象；失败记入 cleanup.json。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../tools.mjs'

export const DEFAULT_BUCKET_PREFIX = 'dsh-video'
export const CLEANUP_REL = 'video/cleanup.json'
export const CLEANUP_MIN_AGE_MS = 24 * 60 * 60 * 1000
export const CLEANUP_SWEEP_INTERVAL_MS = 60 * 60 * 1000

const PREFIX_RE = /^[a-z0-9-]+$/

let lastCleanupSweepAt = 0

export function validateBucketPrefix(raw) {
  const s = String(raw ?? '').trim() || DEFAULT_BUCKET_PREFIX
  if (!PREFIX_RE.test(s)) return { ok: false, problem: '对象路径前缀只允许小写字母、数字和连字符' }
  return { ok: true, prefix: s }
}

export function videoBucketName(cfg) {
  return String(cfg?.videoBucket ?? '').trim()
}

export function videoMaxHeightPx(cfg) {
  const n = parseInt(String(cfg?.videoMaxHeight ?? '480').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 480
}

export function videoBucketEnabled(cfg) {
  return videoCredentialSource(cfg) === 'serviceAccount' && !!videoBucketName(cfg)
}

function videoCredentialSource(cfg) {
  return String(cfg?.videoCredentialSource || '').trim() === 'serviceAccount' ? 'serviceAccount' : 'apiKey'
}

/** @returns {{ bucket: string, prefix: string, maxHeight: number, enabled: boolean }} */
export function videoBucketSettings(cfg) {
  const bucket = videoBucketName(cfg)
  const vp = validateBucketPrefix(cfg?.videoBucketPrefix)
  const prefix = vp.ok ? vp.prefix : DEFAULT_BUCKET_PREFIX
  return {
    bucket,
    prefix,
    maxHeight: videoMaxHeightPx(cfg),
    enabled: videoCredentialSource(cfg) === 'serviceAccount' && !!bucket,
  }
}

export function newTaskId() {
  return randomBytes(8).toString('hex')
}

export function sanitizeObjectFileName(name = 'video.mp4') {
  const base = String(name || 'video.mp4').replace(/[/\\]/g, '_').replace(/[\x00-\x1f\x7f]/g, '')
  const m = base.match(/^(.*?)(\.[a-z0-9]{1,8})?$/i)
  const stem = (m?.[1] || 'video').replace(/^\.+/, '') || 'video'
  const ext = m?.[2] || '.mp4'
  return `${stem.slice(0, 120)}${ext.toLowerCase()}`
}

export function objectKey({ prefix, taskId, fileName }) {
  const id = randomBytes(6).toString('hex')
  return `${prefix}/${taskId}/${id}-${sanitizeObjectFileName(fileName)}`
}

export function gsUri(bucket, objectKeyName) {
  return `gs://${bucket}/${objectKeyName}`
}

/** 仅允许删除 `{prefix}/{taskId}/` 下的对象名（不含 bucket）。 */
export function assertDeletableObjectName({ prefix, taskId, name }) {
  const p = String(prefix || '').trim()
  const t = String(taskId || '').trim()
  const n = String(name || '').replace(/^\/+/, '')
  if (!p || !t || !n) return { ok: false, problem: '删除目标无效' }
  const need = `${p}/${t}/`
  if (!n.startsWith(need)) return { ok: false, problem: '拒绝删除前缀外的对象' }
  if (n.includes('..')) return { ok: false, problem: '拒绝删除非法路径' }
  return { ok: true, name: n }
}

function cleanupPath(root = dataDir()) {
  return join(root || dataDir(), CLEANUP_REL.replace(/^[/\\]+/, ''))
}

export function readCleanupList(root = dataDir()) {
  const file = cleanupPath(root)
  if (!existsSync(file)) return { objects: [], updatedAt: 0 }
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const objects = Array.isArray(j?.objects) ? j.objects.filter((o) => o && typeof o.bucket === 'string' && typeof o.name === 'string') : []
    return { objects, updatedAt: Number(j?.updatedAt) || 0 }
  } catch {
    return { objects: [], updatedAt: 0 }
  }
}

function writeCleanupList(root, data) {
  const file = cleanupPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify({ updatedAt: Date.now(), objects: data.objects || [] }, null, 0), 'utf8')
  renameSync(tmp, file)
}

export function appendCleanupEntry({ root = dataDir(), bucket, name, prefix, recordedAt = Date.now() }) {
  const cur = readCleanupList(root)
  const objects = [...cur.objects, { bucket, name, prefix, recordedAt }]
  writeCleanupList(root, { objects })
}

export async function uploadObjectMedia({ fetchImpl, token, bucket, name, data, mimeType, signal }) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`
  const res = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
    body: data,
  })
  let j = null
  try { j = await res.json() } catch { j = null }
  if (!res?.ok) {
    const msg = j?.error?.message || `HTTP ${res?.status || 0}`
    throw new Error(`上传到存储桶失败：${msg}`)
  }
  return { name: j?.name || name, bucket: j?.bucket || bucket }
}

export async function deleteObject({ fetchImpl, token, bucket, name, prefix, taskId, signal }) {
  const check = assertDeletableObjectName({ prefix, taskId, name })
  if (!check.ok) return { ok: false, skipped: true, problem: check.problem }
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(check.name)}`
  const res = await fetchImpl(url, { method: 'DELETE', signal, headers: { Authorization: `Bearer ${token}` } })
  if (res?.status === 404) return { ok: true, name: check.name }
  if (!res?.ok) {
    let j = null
    try { j = await res.json() } catch { j = null }
    const msg = j?.error?.message || `HTTP ${res?.status || 0}`
    return { ok: false, name: check.name, problem: msg }
  }
  return { ok: true, name: check.name }
}

export async function deleteTaskObjects({ fetchImpl, token, bucket, prefix, taskId, objectNames, root = dataDir(), signal }) {
  const names = [...new Set((objectNames || []).filter(Boolean))]
  const out = []
  for (const name of names) {
    const r = await deleteObject({ fetchImpl, token, bucket, name, prefix, taskId, signal })
    if (!r.ok && !r.skipped) {
      try { appendCleanupEntry({ root, bucket, name: r.name || name, prefix }) } catch {}
    }
    out.push(r)
  }
  return out
}

export async function runCleanupSweep({ fetchImpl, getToken, root = dataDir(), now = () => Date.now(), signal } = {}) {
  if (!fetchImpl || typeof getToken !== 'function') return { swept: 0 }
  const t = now()
  if (t - lastCleanupSweepAt < CLEANUP_SWEEP_INTERVAL_MS) return { swept: 0, skipped: 'interval' }
  lastCleanupSweepAt = t
  const cur = readCleanupList(root)
  if (!cur.objects.length) return { swept: 0 }
  const token = await getToken()
  const keep = []
  let swept = 0
  for (const o of cur.objects) {
    if (t - (Number(o.recordedAt) || 0) < CLEANUP_MIN_AGE_MS) { keep.push(o); continue }
    const parts = String(o.name || '').split('/')
    const taskId = parts.length >= 2 ? parts[parts.length - 2] : ''
    const r = await deleteObject({ fetchImpl, token, bucket: o.bucket, name: o.name, prefix: o.prefix || parts[0] || DEFAULT_BUCKET_PREFIX, taskId, signal })
    if (r.ok) swept++
    else keep.push(o)
  }
  writeCleanupList(root, { objects: keep })
  return { swept }
}

export function resetCleanupSweepClock() {
  lastCleanupSweepAt = 0
}

export async function checkBucketAccess({ fetchImpl, token, bucket, prefix, signal }) {
  const out = { bucket: { ok: false, detail: '' }, write: { ok: false, detail: '' }, delete: { ok: false, detail: '' }, hint: '' }
  const metaUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`
  try {
    const res = await fetchImpl(metaUrl, { method: 'GET', signal, headers: { Authorization: `Bearer ${token}` } })
    let j = null
    try { j = await res.json() } catch { j = null }
    if (!res?.ok) {
      const msg = j?.error?.message || `HTTP ${res?.status || 0}`
      out.bucket.detail = res?.status === 404 ? `存储桶不存在或名称错误：${msg}` : `无法访问存储桶：${msg}`
      out.hint = '最常见原因：服务账号缺少该桶的 storage.objectAdmin（或同等读写删对象）权限。'
      out.suggest = `gcloud storage buckets add-iam-policy-binding gs://${bucket} --member="serviceAccount:YOUR_SA_EMAIL" --role="roles/storage.objectAdmin"`
      return out
    }
    out.bucket.ok = true
    out.bucket.detail = `可访问（位置：${j?.location || '未知'}）`
  } catch (e) {
    out.bucket.detail = `无法访问存储桶：${String(e?.message || e)}`
    out.hint = '最常见原因：服务账号缺少桶级 storage.objectAdmin 权限。'
    return out
  }
  const probeName = `${prefix}/probe-${randomBytes(4).toString('hex')}`
  try {
    await uploadObjectMedia({ fetchImpl, token, bucket, name: probeName, data: Buffer.from('x'), mimeType: 'application/octet-stream', signal })
    out.write.ok = true
    out.write.detail = `探针已写入：${probeName}`
  } catch (e) {
    out.write.detail = `写入探针失败：${String(e?.message || e)}`
    out.hint = '最常见原因：服务账号缺少 storage.objectAdmin 权限。'
    return out
  }
  try {
    const delUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(probeName)}`
    const delRes = await fetchImpl(delUrl, { method: 'DELETE', signal, headers: { Authorization: `Bearer ${token}` } })
    if (delRes?.ok || delRes?.status === 404) {
      out.delete.ok = true
      out.delete.detail = '探针已删除'
    } else {
      let j = null
      try { j = await delRes.json() } catch { j = null }
      out.delete.detail = j?.error?.message || `删除探针失败（HTTP ${delRes?.status || 0}）`
    }
  } catch (e) {
    out.delete.detail = `删除探针失败：${String(e?.message || e)}`
  }
  if (!out.delete.ok) out.hint = '写入成功但删除失败：请确认对象删除权限（storage.objectAdmin）。'
  return out
}
