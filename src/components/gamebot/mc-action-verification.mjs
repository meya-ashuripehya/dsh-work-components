/** Verify a receipt using newer snapshots, without resending an uncertain action. */
export async function verifyWorldAction({ action, params, before, receipt, observe, current,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 20 }) {
  const sequence = Math.max(Number(before.extras?.snapshot_seq) || 0, Number(receipt.observation?.extras?.snapshot_seq) || 0)
  const world = before.extras?.world_id
  const dimension = before.extras?.minecraft?.player?.dimension
  const tolerance = params.arrival_tolerance ?? 1.5
  let after, reason = 'no_fresh_snapshot', distance = null
  for (let n = 0; n < attempts && current(); n++) {
    after = await observe()
    if (!current()) return { after, verified: false, reason: 'cancelled', distance }
    if (!world || after?.extras?.world_id !== world || !dimension || after?.extras?.minecraft?.player?.dimension !== dimension) {
      reason = 'world_or_dimension_changed'; break
    }
    if (!receipt.ok) { reason = 'action_failed'; break }
    if (Number(after.extras?.snapshot_seq) > sequence) {
      if (action === 'drop_item') {
        const evidence = receipt.extras?.evidence || {}
        const oldCount = before.extras?.minecraft?.inventory?.counts?.[params.item_id] || 0
        const newCount = after.extras?.minecraft?.inventory?.counts?.[params.item_id] || 0
        const verified = evidence.spawned === true && evidence.item_id === params.item_id && evidence.count === params.count && oldCount - newCount === params.count
        return { after, verified, reason: verified ? 'spawned_and_inventory_decreased' : 'drop_not_confirmed', distance: null }
      }
      if (action === 'place_block') {
        const evidence = receipt.extras?.evidence || {}
        const verified = evidence.block_id === params.block_id && (evidence.already_present === true || receipt.extras?.effect === 'confirmed' && evidence.material_before - evidence.material_after === 1)
        return { after, verified, reason: verified ? evidence.already_present ? 'already_present' : 'placed_and_material_consumed' : 'placement_not_confirmed', distance: null }
      }
      if (action === 'break_block') {
        const evidence = receipt.extras?.evidence || {}
        if (evidence.destroyed === true && evidence.block_id === params.expected_block) return { after, verified: true, reason: 'destroyed_not_acquired', distance: null }
        reason = 'destruction_not_confirmed'
        break
      }
      distance = after.position ? Math.hypot(after.position.x - params.x, after.position.y - params.y, after.position.z - params.z) : null
      if (action !== 'move_to' || (Number.isFinite(distance) && distance <= tolerance + 1e-6)) {
        return { after, verified: true, reason: 'confirmed', distance }
      }
      reason = 'outside_arrival_tolerance'
    }
    if (n + 1 < attempts) await sleep(100)
  }
  return { after, verified: false, reason: current() ? reason : 'cancelled', distance }
}
