import { posKey } from './model.mjs'

/** 同一格同时只放行一步，另一方退让。 */
export function admit(steps) {
  const taken = new Set()
  return steps.map((step) => {
    const key = posKey(step.pos)
    if (taken.has(key)) return { member_id: step.member_id, result: 'yield', pos: key }
    taken.add(key)
    return { member_id: step.member_id, result: 'go', pos: key }
  })
}
