import { cellAt } from './materials.mjs'

/**
 * 能改的只有凭证列出的指定方块格，以及单独授予拆除的格子。
 * 必须为空不附带拆除。图纸外的坐标拒绝。
 */
export function authorize(project, claim, pos, action) {
  if (!claim || claim.status !== 'active') return { ok: false, error: '没有有效认领' }
  const task = project.tasks.find((item) => item.id === claim.tid)
  if (task && claim.bv !== (task.blueprint_version || project.blueprint_version)) return { ok: false, error: '图纸版本已变' }
  const cell = cellAt(project, pos)
  if (cell?.kind === 'out_of_scope') return { ok: false, error: '该格不归任务管' }
  if (cell && action === 'break' && !cell.grants_break) return { ok: false, error: '没有拆除许可' }
  if (cell && action === 'place' && cell.kind !== 'specified') return { ok: false, error: '这个位置不能放置' }
  const listed = (claim.cells || []).some((item) => item.x === pos.x && item.y === pos.y && item.z === pos.z)
  if (!listed) return { ok: false, error: '坐标不在认领凭证里' }
  if (!(claim.act || []).includes(action)) return { ok: false, error: '凭证没有这个动作' }
  if (!cell) return { ok: false, error: '坐标不在图纸里' }
  return { ok: true, cell }
}
