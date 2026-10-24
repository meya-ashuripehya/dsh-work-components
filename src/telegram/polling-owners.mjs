/**
 * 记录「哪个子系统打算 / 正在轮询某个令牌」。通道在启动前 claim，停止时 release；
 * 聊天室据此决定自拉还是订阅 raw-hub，避免双 getUpdates → 409。
 * 键为 tokenHash，不存明文。
 * 与 raw-hub 一样挂 globalThis，供 lib/index.mjs 与 lib/channel-telegram.mjs 共享。
 */
import { tokenHash } from './raw-hub.mjs'

const GKEY = '__dshWorkbenchTelegramPollingOwners'

function store() {
  if (!globalThis[GKEY]) globalThis[GKEY] = new Map()
  return globalThis[GKEY]
}

export function claimPollingToken(token, owner, accountId = '') {
  const h = tokenHash(token)
  if (!h || !owner) return
  const owners = store()
  let row = owners.get(h)
  if (!row) { row = { owner, accountIds: new Set() }; owners.set(h, row) }
  row.owner = owner
  if (accountId) row.accountIds.add(accountId)
}

export function releasePollingToken(token, owner) {
  const h = tokenHash(token)
  if (!h) return
  const owners = store()
  const row = owners.get(h)
  if (!row) return
  if (owner && row.owner !== owner) return
  owners.delete(h)
}

export function releaseAll(owner) {
  const owners = store()
  for (const [h, row] of [...owners]) {
    if (!owner || row.owner === owner) owners.delete(h)
  }
}

export function pollingOwnerOf(token) {
  const h = tokenHash(token)
  return h ? (store().get(h)?.owner || null) : null
}

export function channelOwnsToken(token) {
  return pollingOwnerOf(token) === 'channel'
}

export function resetPollingOwners() { store().clear() }
