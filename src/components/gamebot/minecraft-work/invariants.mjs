import { activeReservations } from './workspace.mjs'
import { posKey } from './model.mjs'

/** Stock conservation: warehouse + carried + consumed === initial fixture stock (per item). */
export function stockLedger(project) {
  const ledger = {}
  for (const [itemId, item] of Object.entries(project.materials?.items || {})) {
    const carried = Object.values(item.carried || {}).reduce((n, q) => n + q, 0)
    const consumed = (item.consumed || []).reduce((n, c) => n + c.qty, 0)
    ledger[itemId] = {
      stock: item.stock,
      reserved: item.reserved,
      carried,
      consumed,
      total: item.stock + carried + consumed,
    }
  }
  return ledger
}

export function assertStockConservation(project, baselineTotals) {
  const ledger = stockLedger(project)
  for (const [itemId, base] of Object.entries(baselineTotals || {})) {
    const row = ledger[itemId]
    if (!row || row.total !== base) {
      return { ok: false, error: `stock drift ${itemId}: ${row?.total} !== ${base}` }
    }
  }
  return { ok: true }
}

export function assertNoOverlappingReservations(project) {
  const held = activeReservations(project)
  for (let i = 0; i < held.length; i++) {
    for (let j = i + 1; j < held.length; j++) {
      const a = held[i].envelope
      const b = held[j].envelope
      const overlap = !(
        a.max.x < b.min.x || a.min.x > b.max.x
        || a.max.y < b.min.y || a.min.y > b.max.y
        || a.max.z < b.min.z || a.min.z > b.max.z
      )
      if (overlap && !(held[i].member_id === held[j].member_id && held[i].task_id === held[j].task_id)) {
        return { ok: false, error: 'overlapping workspace reservations' }
      }
    }
  }
  return { ok: true }
}

export function assertSingleActiveClaimPerTask(project, taskId) {
  const active = project.claims.filter((c) => c.tid === taskId && c.status === 'active')
  if (active.length > 1) return { ok: false, error: 'multiple active claims' }
  return { ok: true }
}

export function assertOperationSideEffects(project, { appliedOps = new Set() } = {}) {
  const settled = project.inflight.filter((e) => e.status === 'settled')
  for (const e of settled) {
    if (!appliedOps.has(e.operation_id)) {
      return { ok: false, error: `settled without recorded op ${e.operation_id}` }
    }
  }
  const consumed = []
  for (const item of Object.values(project.materials?.items || {})) {
    for (const c of item.consumed || []) consumed.push(c.operation_id)
  }
  for (const op of consumed) {
    if (!appliedOps.has(op)) return { ok: false, error: `consumed without recorded op ${op}` }
  }
  return { ok: true }
}

export function checkSchedulingInvariants(project, ctx = {}) {
  const parts = [
    assertNoOverlappingReservations(project),
    ...(ctx.taskId ? [assertSingleActiveClaimPerTask(project, ctx.taskId)] : []),
    ...(ctx.baselineTotals ? [assertStockConservation(project, ctx.baselineTotals)] : []),
    ...(ctx.appliedOps ? [assertOperationSideEffects(project, { appliedOps: ctx.appliedOps })] : []),
  ]
  const bad = parts.find((p) => !p.ok)
  return bad || { ok: true }
}
