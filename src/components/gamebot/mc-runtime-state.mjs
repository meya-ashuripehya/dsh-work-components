export const activeTask = (task) => ['accepted', 'running'].includes(task?.state)
export const presentTask = (task, stalled) => stalled && activeTask(task) ? { ...task, state: 'paused', last_known_state: task.state, pause_reason: 'world_observation_stalled' } : task

/** A new HTTP read of a cached snapshot is not new game evidence. */
export function updateFreshness(state, observation, at) {
  const generation = observation.extras?.connection_generation
  if (generation != null && state.bridgeGeneration != null && generation !== state.bridgeGeneration) {
    state.lastSeq = null; state.stalled = true; state.recovering = true; state.freshSamples = 0
  }
  if (generation != null) state.bridgeGeneration = generation
  const seq = Number(observation.extras?.snapshot_seq)
  const time = Number(observation.extras?.game_time ?? observation.extras?.minecraft?.game_time)
  const age = observation.extras?.snapshot_age_ms
  if (!Number.isFinite(seq) || !Number.isFinite(time) || seq <= 0) {
    state.stalled = true; state.freshSamples = 0; return false
  }
  if (state.lastSeq == null) {
    state.lastSeq = seq; state.lastGameTime = time; state.lastAdvanceAt = at
    state.stalled = !!state.recovering || age == null || age > 3000
    state.freshSamples = 0
  } else if (seq > state.lastSeq && time > state.lastGameTime) {
    state.lastAdvanceAt = at; state.freshSamples = (state.freshSamples || 0) + 1
    state.lastSeq = seq; state.lastGameTime = time
    if (state.freshSamples >= 2 && age != null && age <= 3000) { state.stalled = false; state.recovering = false }
  }
  if (at - state.lastAdvanceAt > 3000 || (age != null && age > 3000)) {
    state.stalled = true; state.freshSamples = 0
  }
  return !state.stalled
}

export function taskEvent(state, task, world, dimension) {
  if (!task?.event_id) return null
  const id = `${world}:${dimension}:${task.event_id}`
  state.taskEventsSeen ||= new Set()
  if (state.taskEventsSeen.has(id)) return null
  state.taskEventsSeen.add(id)
  if (state.taskEventsSeen.size > 128) state.taskEventsSeen.delete(state.taskEventsSeen.values().next().value)
  return { id, task_id: task.task_id, state: task.state, reason: task.reason, goal: task.goal }
}
