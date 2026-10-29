function busy(project) {
  return project.inflight.some((item) => item.status === 'inflight' || item.status === 'unknown')
}

/** 普通备注不改变执行状态。 */
export function addNote(project, text) {
  project.notes.push(String(text || ''))
  return { execution: project.control.execution, stop: project.control.stop }
}

/**
 * 紧急停止先记「已收到」。没有在途动作时同一回执里再记「已停」。
 * 已发出的动作改为未知，不自动重放。
 */
export function bumpControlRevision(project) {
  project.control.revision = (project.control.revision || 0) + 1
  return project.control.revision
}

export function controlStateToken(project) {
  return {
    revision: project.control.revision || 0,
    execution: project.control.execution,
    stopPhase: project.control?.stop?.phase ?? null,
    loopPhase: project.loop?.phase ?? null,
  }
}

export function controlTokensMatch(a, b) {
  return a.revision === b.revision
    && a.execution === b.execution
    && a.stopPhase === b.stopPhase
    && a.loopPhase === b.loopPhase
}

export function requestStop(project, now) {
  const receivedAt = now
  bumpControlRevision(project)
  for (const item of project.inflight) {
    if (item.status !== 'inflight') continue
    if (item.sent) {
      item.status = 'unknown'
      item.replay = false
      project.unknown.push(item)
    } else {
      item.status = 'cancelled'
    }
  }
  const stopped = !busy(project)
  project.control.stop = stopped
    ? { phase: 'stopped', received_at: receivedAt, stopped_at: now }
    : { phase: 'received', received_at: receivedAt, stopped_at: null }
  project.control.execution = stopped ? 'stopped' : 'stopping'
  project.loop.phase = stopped ? 'stopped' : project.loop.phase
  return {
    received: true,
    stopped,
    stop: project.control.stop,
    execution: project.control.execution,
  }
}

export function acknowledgeSettled(project, operationId, now) {
  const item = project.inflight.find((entry) => entry.operation_id === operationId)
  if (item && item.status === 'unknown') item.status = 'settled'
  if (project.control.stop?.phase === 'received' && !busy(project)) {
    project.control.stop = { phase: 'stopped', received_at: project.control.stop.received_at, stopped_at: now }
    project.control.execution = 'stopped'
    project.loop.phase = 'stopped'
  }
  return project.control.stop
}
