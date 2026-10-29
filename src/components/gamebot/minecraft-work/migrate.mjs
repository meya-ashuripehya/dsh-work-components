/** Legacy projects without world_id cannot be scheduled until bound to a save. */
export function migrateProject(project) {
  if (!project) return null
  if (project.world_id && typeof project.world_id === 'string') return project
  return {
    ...project,
    world_id: null,
    legacy_blocked: true,
    migration: 'needs_world_identity',
  }
}

export function storageFileName(worldId, projectId) {
  const w = String(worldId || '').replace(/[^a-z0-9._-]/gi, '_')
  const p = String(projectId || '')
  if (!w) return `${p}.json`
  return `${w}__${p}.json`
}

export function parseStorageFileName(fileBase) {
  const name = fileBase.replace(/\.json$/, '')
  const idx = name.indexOf('__')
  if (idx < 0) return { world_id: null, project_id: name, legacy: true }
  return { world_id: name.slice(0, idx), project_id: name.slice(idx + 2), legacy: false }
}
