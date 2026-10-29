/**
 * MC 每席回复队列（成员决定）：
 *   - 每个已连接席位各自一条队列；公屏与私聊都进同一条通道，挨个处理。
 *   - 玩家公聊：入队到每个已连接席位（各席自行决定是否 / 何时回）。
 *   - 私聊：只入队到相关席位（该席 observe 里出现的 private）。
 *   - 同一席位同时只有一个 active（队首）；不同席位可并行。
 *   - AI 公聊不 fan-out 入队 / 武装。
 *   - 不做预算 / end_round / 交棒。
 */

/**
 * @typedef {{ id: string, audience: string, kind: string, speaker: string, text: string, target: string, memberId: string }} SeatQueueItem
 */

function blankSeat() {
  return {
    /** @type {SeatQueueItem[]} */
    pending: [],
    /** @type {SeatQueueItem|null} */
    active: null,
    /** @type {Set<string>} */
    seen: new Set(),
  }
}

function normalize(raw) {
  const id = String(raw?.id || '').trim()
  return {
    id,
    audience: String(raw?.audience || 'public'),
    kind: String(raw?.kind || 'bystander'),
    speaker: String(raw?.speaker || raw?.player || raw?.name || ''),
    text: String(raw?.text || ''),
    target: String(raw?.target || ''),
    memberId: String(raw?.memberId || ''),
  }
}

export function createSeatQueues() {
  /** @type {Map<string, ReturnType<typeof blankSeat>>} */
  const seats = new Map()

  function seatOf(memberId) {
    const id = String(memberId || '').trim()
    let seat = seats.get(id)
    if (!seat) {
      seat = blankSeat()
      seats.set(id, seat)
    }
    return seat
  }

  function remember(seat, id) {
    if (!id || seat.seen.has(id)) return false
    seat.seen.add(id)
    if (seat.seen.size > 500) {
      const keep = new Set()
      if (seat.active?.id) keep.add(seat.active.id)
      for (const item of seat.pending) if (item.id) keep.add(item.id)
      keep.add(id)
      seat.seen = keep
    }
    return true
  }

  return {
    /**
     * 入队（按 event id 去重）。不自动升 active。
     * @returns {boolean} 是否新入队
     */
    enqueue(memberId, raw) {
      const id = String(memberId || '').trim()
      if (!id) return false
      const item = normalize(raw)
      if (!item.id) return false
      const seat = seatOf(id)
      if (!remember(seat, item.id)) return false
      seat.pending.push(item)
      return true
    },

    /** 玩家公聊：写入每个席位的队列。返回新入队的席位 id。 */
    enqueuePublic(raw, seatIds) {
      const item = normalize({ ...raw, audience: raw?.audience || 'public' })
      const hit = []
      for (const sid of seatIds || []) {
        if (this.enqueue(sid, item)) hit.push(String(sid).trim())
      }
      return hit
    },

    /** 私聊：只写入目标席位。 */
    enqueuePrivate(memberId, raw) {
      return this.enqueue(memberId, { ...raw, audience: 'private' })
    },

    /**
     * 若尚无 active，从 pending 取出队首升为 active。
     * @returns {SeatQueueItem|null}
     */
    activateNext(memberId) {
      const seat = seatOf(memberId)
      if (seat.active) return seat.active
      while (seat.pending.length) {
        const next = seat.pending.shift()
        if (!next?.id) continue
        seat.active = next
        return next
      }
      return null
    },

    /** 当前队首（正在处理的条目）。 */
    active(memberId) {
      return seatOf(memberId).active
    },

    /**
     * 回合结束：丢掉 active，升下一条。返回新的 active（或 null）。
     * outcome 仅供观测，不改变队列顺序。
     */
    finish(memberId, _outcome) {
      const seat = seatOf(memberId)
      seat.active = null
      return this.activateNext(memberId)
    },

    /**
     * note/武装失败时：把 active 退回 pending 队首，避免卡死。
     * @returns {SeatQueueItem|null}
     */
    releaseActive(memberId) {
      const seat = seatOf(memberId)
      if (!seat.active) return null
      const item = seat.active
      seat.active = null
      seat.pending.unshift(item)
      return item
    },

    armId(memberId, item) {
      const sid = String(memberId || '').trim()
      const id = String(item?.id || '').trim()
      if (!sid || !id) return ''
      return `${id}:arm:${sid}`
    },

    /** 允许同一 event id 在失败后重新入队（从 control.seen / 本席 seen 摘掉）。 */
    forget(memberId, eventId) {
      const id = String(memberId || '').trim()
      const eid = String(eventId || '').trim()
      if (!id || !eid) return false
      const seat = seats.get(id)
      if (!seat) return false
      return seat.seen.delete(eid)
    },

    clear(memberId) {
      if (memberId == null || memberId === '') {
        seats.clear()
        return
      }
      seats.delete(String(memberId).trim())
    },

    view(memberId) {
      const id = String(memberId || '').trim()
      if (!id) {
        return [...seats.entries()].map(([seatId, seat]) => ({
          seatId,
          active: seat.active,
          pending: seat.pending.map((item) => item.id),
          pendingCount: seat.pending.length,
        }))
      }
      const seat = seats.get(id)
      if (!seat) return null
      return {
        seatId: id,
        active: seat.active,
        pending: seat.pending.map((item) => ({ ...item })),
        pendingCount: seat.pending.length,
      }
    },
  }
}