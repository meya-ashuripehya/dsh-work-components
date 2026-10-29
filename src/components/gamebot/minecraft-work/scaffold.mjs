import { posKey } from './model.mjs'

export function addScaffold(project, scaffold) {
  project.scaffolds.push({
    id: scaffold.id,
    x: scaffold.x,
    y: scaffold.y,
    z: scaffold.z,
    material: scaffold.material || 'minecraft:scaffolding',
    purpose: scaffold.purpose || '够到图纸方块',
    users: [...(scaffold.users || [])],
    dependents: [...(scaffold.dependents || [])],
    status: 'up',
  })
  return project.scaffolds.at(-1)
}

export function requestRemove(scaffold) {
  if (scaffold.users.length) return { ok: false, error: '仍有人使用' }
  if (scaffold.dependents.length) return { ok: false, error: '后续任务仍依赖' }
  return { ok: true, pos: posKey(scaffold) }
}
