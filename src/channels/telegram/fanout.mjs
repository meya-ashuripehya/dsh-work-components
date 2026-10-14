/**
 * 一个注册 id（telegram）后面挂多个长轮询。
 * 通道注册表按适配器 id 只能有一个，出站也只按 channelId 取适配器，
 * 所以这里对外仍是 id=telegram，按 target.accountId 把发送、编辑、输入状态分到对应机器人。
 * 每个子适配器自己 getUpdates；入站事件上的 accountId 由子适配器配置写入，会话键因此彼此分开。
 */
import { UPDATE_ACCOUNT_KEY } from './accounts.mjs'

export function stampUpdateAccount(raw, accountId) {
  if (!raw || typeof raw !== 'object' || !accountId) return raw
  try { raw[UPDATE_ACCOUNT_KEY] = accountId } catch { /* 冻结的更新对象就跳过 */ }
  return raw
}

function contextFor(ctx, accountId, decorateContext) {
  const base = decorateContext ? decorateContext(ctx, accountId) : ctx
  const emit = typeof base.emit === 'function' ? base.emit.bind(base) : null
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'emit') {
        return (event) => {
          if (event && typeof event === 'object') stampUpdateAccount(event.raw, accountId)
          return emit ? emit(event) : undefined
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * @param {{ id: string, name?: string, adapter: object }[]} entries 已构造、尚未 start 的子适配器
 * @param {{ decorateContext?: (ctx: object, accountId: string) => object }} [options]
 */
export function createTelegramFanout(entries, options = {}) {
  const children = (entries || []).filter((e) => e?.adapter && e.id)
  const byId = new Map(children.map((c) => [c.id, c]))
  const conflicts = new Set()
  const first = children[0]?.adapter
  const decorateContext = options.decorateContext

  function pick(target) {
    const id = target?.accountId
    return (id && byId.get(id)) || byId.get('main') || children[0]
  }
  function childAdapter(target) {
    const hit = pick(target)
    if (!hit) throw new Error('没有可发送的 Telegram 机器人')
    return hit.adapter
  }

  return {
    id: 'telegram',
    capabilities: first?.capabilities,
    manifest: first?.manifest,
    outboxCapabilities: first?.outboxCapabilities,
    conflicts,
    async start(ctx) {
      for (const child of children) {
        await child.adapter.start(contextFor(ctx, child.id, decorateContext))
      }
    },
    async stop() {
      for (const child of children) {
        try { await child.adapter.stop?.() } catch { /* 逐个停下，一个失败不挡住其余 */ }
      }
    },
    /** 记下某个机器人的 409，并停掉它自己的轮询。全部冲突时返回 true。 */
    markConflict(accountId) {
      if (!accountId || conflicts.has(accountId)) return conflicts.size >= children.length && children.length > 0
      conflicts.add(accountId)
      const child = byId.get(accountId)
      void child?.adapter.stop?.()
      return conflicts.size >= children.length
    },
    send(target, message) { return childAdapter(target).send(target, message) },
    createReply(target, replyOptions) { return childAdapter(target).createReply(target, replyOptions) },
    edit(target, messageId, message) { return childAdapter(target).edit(target, messageId, message) },
    resolveStreamingMode(target) { return childAdapter(target).resolveStreamingMode?.(target) },
    startTypingForTarget(target) { return childAdapter(target).startTypingForTarget?.(target) },
    stopTypingForTarget(target) { return childAdapter(target).stopTypingForTarget?.(target) },
    async describe() {
      const bots = []
      for (const child of children) {
        let health = null
        try { health = await child.adapter.getHealth?.() } catch { health = null }
        bots.push({
          id: child.id,
          name: child.name || child.id,
          username: child.adapter.botIdentity?.username || '',
          conflict: conflicts.has(child.id),
          health,
        })
      }
      const up = bots.filter((b) => b.health?.status === 'ok')
      let health
      if (!bots.length) health = { status: 'down', detail: 'no bots', authenticated: false }
      else if (up.length === bots.length) health = { status: 'ok', detail: 'connected', authenticated: true }
      else if (up.length > 0) health = { status: 'ok', detail: 'partial', authenticated: true }
      else if (bots.some((b) => b.health?.authenticated)) health = { status: 'down', detail: 'authenticated but receive loop down', authenticated: true }
      else health = bots[0].health || { status: 'down', detail: 'not started', authenticated: false }
      return { health, bots }
    },
  }
}
