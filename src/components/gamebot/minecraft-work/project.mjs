import { expand } from './blueprint.mjs'
import { materialsFrom } from './materials.mjs'
import { STEP_CAP } from './model.mjs'
import { specFromRawFixture } from './raw-blocks.mjs'
import { tasksFrom } from './tasks.mjs'

export function createProjectFromRawFixture(fixture, anchor, options) {
  const spec = specFromRawFixture(fixture, anchor)
  const project = createProject(spec, options)
  project.provenance = spec.provenance
  return project
}

export function createProject(spec, { id, now, world_id = null, material_stock = {}, fill_test_stock = false }) {
  const expanded = expand(spec)
  const materials = materialsFrom(expanded.cells, { stock: material_stock })
  if (fill_test_stock) {
    for (const item of Object.values(materials.items)) {
      if (item.stock < item.gap) item.stock = item.gap
    }
  }
  return {
    id,
    world_id,
    legacy_blocked: !world_id,
    blueprint_version: 1,
    anchor: expanded.anchor,
    applied_defaults: expanded.applied_defaults,
    parts: spec.parts,
    cells: expanded.cells,
    tasks: tasksFrom(expanded),
    claims: [],
    materials,
    workspace: [],
    conflicts: [],
    scaffolds: [],
    meetings: [],
    control: { execution: 'idle', stop: null },
    inflight: [],
    unknown: [],
    replacements: [],
    assignments: [],
    journal: [],
    progress: { done: [] },
    revocations: {},
    loop: { steps: 0, cap: STEP_CAP, phase: 'idle' },
    notes: [],
    created_at: new Date(now * 1000).toISOString(),
  }
}

export function publicView(project) {
  const view = structuredClone(project)
  delete view.claim_key
  return view
}
