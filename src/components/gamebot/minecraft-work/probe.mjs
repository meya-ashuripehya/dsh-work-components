/**
 * A probe is fresh only when it was taken after the action receipt.
 * Requesting observe again is not itself proof. nearby_blocks absence is not air.
 */

export function assessProbe(probe, { beforeSeq = 0, afterGameTime, dimension } = {}) {
  if (!probe || probe.ok === false) return { ok: false, reason: 'probe_failed' }
  if (dimension && probe.dimension !== dimension) return { ok: false, reason: 'dimension_mismatch' }
  if (!Number.isFinite(probe.probe_seq) || probe.probe_seq <= beforeSeq) return { ok: false, reason: 'stale_probe' }
  if (!Number.isFinite(afterGameTime) || !Number.isFinite(probe.game_time) || probe.game_time < afterGameTime) {
    return { ok: false, reason: 'probe_not_after_action' }
  }
  const cells = []
  for (const cell of probe.cells || []) {
    if (!cell || cell.loaded === false || cell.block_id == null) {
      return { ok: false, reason: 'cell_unknown', cell }
    }
    cells.push(cell)
  }
  return { ok: true, cells }
}

export function actionGameTime(outcome) {
  if (!outcome) return undefined
  if (Number.isFinite(outcome.game_time)) return outcome.game_time
  if (Number.isFinite(outcome.evidence?.game_time)) return outcome.evidence.game_time
  return undefined
}
