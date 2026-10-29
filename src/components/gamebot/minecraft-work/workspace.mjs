import { posKey, parseKey } from './model.mjs'

function keysInBox(min, max) {
  const out = []
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) out.push(posKey({ x, y, z }))
    }
  }
  return out
}

export function envelopeFor(cell, agentPos) {
  const body = agentPos
    ? [{ x: agentPos.x, y: agentPos.y, z: agentPos.z }, { x: agentPos.x, y: agentPos.y + 1, z: agentPos.z }]
    : []
  const target = [{ x: cell.x, y: cell.y, z: cell.z }]
  const all = [...body, ...target]
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const p of all) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z)
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z)
  }
  return { min, max, keys: keysInBox(min, max) }
}

export function overlaps(a, b) {
  return !(
    a.max.x < b.min.x || a.min.x > b.max.x
    || a.max.y < b.min.y || a.min.y > b.max.y
    || a.max.z < b.min.z || a.min.z > b.max.z
  )
}

export function activeReservations(project) {
  return (project.workspace || []).filter((r) => r.status === 'held')
}

export function reserveWorkspace(project, { member_id, task_id, envelope, now }) {
  for (const held of activeReservations(project)) {
    if (held.member_id === member_id && held.task_id === task_id) continue
    if (overlaps(held.envelope, envelope)) return { ok: false, error: '工作区重叠' }
  }
  const entry = {
    member_id,
    task_id,
    envelope,
    status: 'held',
    at: now,
  }
  project.workspace = [...(project.workspace || []), entry]
  return { ok: true, project, reservation: entry }
}

export function releaseWorkspace(project, member_id, task_id) {
  project.workspace = (project.workspace || []).map((r) => {
    if (r.member_id === member_id && r.task_id === task_id && r.status === 'held') return { ...r, status: 'released' }
    return r
  })
  return project
}

export function parseEnvelopeKeys(keys) {
  return keys.map(parseKey)
}
