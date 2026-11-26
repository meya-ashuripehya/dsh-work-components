import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Only public state is persisted. Private turns must never call record(). */
export function createWorldMemory(root) {
  const path = () => join(root?.() || '', 'minecraft-autonomy.json')
  let worlds = {}
  try { worlds = JSON.parse(readFileSync(path(), 'utf8')).worlds || {} } catch {}
  return {
    get(world, seat) { return worlds[world]?.[seat] || { goal: '', history: [] } },
    record(world, seat, row) {
      if (!world) return
      const state = this.get(world, seat)
      state.goal = String(row.goal || state.goal || '').slice(0, 1000)
      state.history = [...state.history, row].slice(-20)
      ;(worlds[world] ||= {})[seat] = state
      if (!root?.()) return
      mkdirSync(root(), { recursive: true })
      writeFileSync(path() + '.tmp', JSON.stringify({ worlds }), 'utf8')
      renameSync(path() + '.tmp', path())
    },
    perceive(world, seat, dimension, points) {
      const state = this.get(world, seat)
      state.perception ||= {}
      const known = state.perception[dimension] ||= {}
      const observedPositions = new Set((points || []).map((point) => JSON.stringify(point.pos)))
      for (const [key, point] of Object.entries(known)) if (observedPositions.has(JSON.stringify(point.pos))) delete known[key]
      for (const point of points || []) known[`${point.block_id}:${JSON.stringify(point.pos)}`] = { ...structuredClone(point), visibility: 'last_seen' }
      const entries = Object.entries(known).sort((a, b) => (b[1].observed_at || 0) - (a[1].observed_at || 0)).slice(0, 128)
      state.perception[dimension] = Object.fromEntries(entries)
      ;(worlds[world] ||= {})[seat] = state
      const current = new Set((points || []).map((p) => `${p.block_id}:${JSON.stringify(p.pos)}`))
      return entries.filter(([key]) => !current.has(key)).slice(0, 12).map(([, value]) => value)
    },
  }
}

export function observationContext(obs) {
  const mc = obs?.extras?.minecraft || {}
  return { world_id: obs?.extras?.world_id, position: obs?.position, health: obs?.health,
    player: mc.player, nearby_players: mc.nearby_players || obs?.nearby_players,
    nearby_agents: mc.nearby_agents, terrain_summary: mc.terrain_summary || {}, points_of_interest: (mc.points_of_interest || []).slice(0, 24),
    task: mc.task || null,
    inventory: mc.inventory || { slots: [], counts: {} },
    nearby_items: (mc.nearby_items || []).slice(0, 24), recent_pickups: (mc.recent_pickups || []).slice(-20),
    standable_goals: (mc.standable_goals || []).slice(0, 24),
    dimension: mc.player?.dimension, last_error: obs?.last_error }
}

/** Keep execution history useful without repeating twenty full terrain scans. */
export function compactControlHistory(state) {
  return { goal: state.goal, history: (state.history || []).slice(-20).map((row) => ({ ...row,
    actions: (row.actions || []).map((a) => ({ ...a, after: a.after ? { world_id: a.after.world_id, position: a.after.position, dimension: a.after.dimension,
      ...(a.after.task ? { task: { task_id: a.after.task.task_id, state: a.after.task.state, reason: a.after.task.reason } } : {}) } : undefined })),
  })) }
}

/** Race the model as well as aborting it: a provider may ignore cancellation. */
export async function boundedCall(call, signal, timeoutMs = 90000) {
  const abort = new AbortController()
  let timer
  let rejectAbort
  const onAbort = () => { abort.abort(); rejectAbort?.(new Error('control turn cancelled')) }
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        rejectAbort = reject
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
        timer = setTimeout(() => { abort.abort(); reject(new Error('model timeout after 90s')) }, timeoutMs)
      }),
      Promise.resolve().then(() => { if (abort.signal.aborted) throw new Error('control turn cancelled'); return call(abort.signal) }),
    ])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}
