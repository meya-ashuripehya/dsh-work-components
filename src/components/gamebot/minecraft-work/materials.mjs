import { posKey } from './model.mjs'
import { itemForBlock, workUnitsForCell } from './blocks.mjs'

export function materialsFrom(cells, { stock = {} } = {}) {
  const items = {}
  for (const cell of cells) {
    if (cell.kind !== 'specified' || !cell.block_id) continue
    const itemId = itemForBlock(cell.block_id)
    if (!itemId) continue
    const item = items[itemId] || (items[itemId] = { stock: 0, reserved: 0, in_transit: 0, carried: {}, gap: 0, grants: [] })
    item.gap += 1
    if (stock[itemId] != null) item.stock = stock[itemId]
  }
  for (const [id, qty] of Object.entries(stock)) {
    if (!items[id]) items[id] = { stock: qty, reserved: 0, in_transit: 0, carried: {}, gap: 0, grants: [] }
    else items[id].stock = qty
  }
  return { items }
}

function availableWarehouse(item) {
  return item.stock - item.reserved - item.in_transit
}

export function totalCarried(item) {
  return Object.values(item.carried || {}).reduce((n, q) => n + q, 0)
}

export function shortagesForDemand(project, demand) {
  const shortages = []
  for (const [itemId, need] of Object.entries(demand || {})) {
    const item = project.materials?.items?.[itemId]
    if (!item) {
      shortages.push({ item_id: itemId, short: need })
      continue
    }
    const available = availableWarehouse(item) + totalCarried(item)
    if (need > available) shortages.push({ item_id: itemId, short: need - available })
  }
  return shortages
}

export function warehouseSnapshot(project) {
  const out = {}
  for (const [id, item] of Object.entries(project.materials?.items || {})) {
    out[id] = item.stock + totalCarried(item) + (item.consumed || []).reduce((n, c) => n + c.qty, 0)
  }
  return out
}

export function reserve(project, { member_id, item_id, qty, now, collect = false }) {
  if (!project) return { ok: false, error: '没有这个项目' }
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: '领取数量必须是正整数' }
  const item = project.materials?.items?.[item_id]
  if (!item) return { ok: false, error: '没有这种材料' }
  const open = availableWarehouse(item)
  if (qty > open) return { ok: false, error: '仓库库存不足' }
  item.reserved += qty
  const grant = { member_id, qty, at: now, collected: false }
  item.grants.push(grant)
  if (collect) {
    item.reserved -= qty
    item.stock -= qty
    item.carried[member_id] = (item.carried[member_id] || 0) + qty
    grant.collected = true
  }
  return { ok: true, project, open: open - qty }
}

export function collectReserved(project, { member_id, item_id, qty, now }) {
  const item = project.materials?.items?.[item_id]
  if (!item) return { ok: false, error: '没有这种材料' }
  const grants = item.grants.filter((g) => g.member_id === member_id && !g.collected)
  const pending = grants.reduce((n, g) => n + g.qty, 0)
  if (qty > pending) return { ok: false, error: '没有这么多待领取预留' }
  let left = qty
  for (const g of grants) {
    if (left <= 0) break
    const take = Math.min(g.qty, left)
    g.qty -= take
    left -= take
    if (g.qty <= 0) g.collected = true
  }
  item.reserved -= qty
  item.stock -= qty
  item.carried[member_id] = (item.carried[member_id] || 0) + qty
  return { ok: true, project }
}

export function refundOperation(project, memberId, cell, { operation_id, now }) {
  const units = workUnitsForCell(cell)
  for (const unit of units) {
    if (!unit.item_id) continue
    const item = project.materials.items[unit.item_id]
    if (!item) continue
    const idx = (item.consumed || []).findIndex((c) => c.operation_id === operation_id)
    if (idx < 0) continue
    const [{ qty }] = item.consumed.splice(idx, 1)
    item.carried[memberId] = (item.carried[memberId] || 0) + qty
  }
  return { ok: true, project }
}

export function consumeForOperation(project, memberId, cell, { operation_id, now }) {
  const units = workUnitsForCell(cell)
  for (const unit of units) {
    if (!unit.item_id) continue
    const item = project.materials.items[unit.item_id]
    if (!item) return { ok: false, error: '没有这种材料' }
    const carried = item.carried[memberId] || 0
    if (carried < unit.qty) return { ok: false, error: '携带材料不足' }
    item.carried[memberId] = carried - unit.qty
    item.consumed = item.consumed || []
    item.consumed.push({ member_id: memberId, qty: unit.qty, operation_id, at: now })
  }
  return { ok: true, project }
}

export function releaseMemberReservations(project, memberId, { uncollectedOnly = true } = {}) {
  for (const item of Object.values(project.materials?.items || {})) {
    const kept = []
    for (const g of item.grants || []) {
      if (g.member_id !== memberId) {
        kept.push(g)
        continue
      }
      if (g.collected) {
        kept.push(g)
        continue
      }
      item.reserved -= g.qty
    }
    item.grants = kept
  }
  return project
}

export function cellAt(project, pos) {
  const key = typeof pos === 'string' ? pos : posKey(pos)
  return project.cells.find((cell) => posKey(cell) === key) || null
}
