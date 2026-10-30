import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMembersTools } from '../members-tools.mjs'
import { testSite } from './model.mjs'
import { createWorkRuntime, createWorkTools, workModulesStayOffScheduler } from './tools.mjs'
import { resetExecuteOpIds } from './execute.mjs'

const KEY = 'claim-key-must-stay-out-of-receipts'
const seat = (id) => ({ game: { caller: { memberId: id } } })

function harness() {
  resetExecuteOpIds()
  const dir = mkdtempSync(join(tmpdir(), 'mc-tools-'))
  let actSeq = 0
  const runtime = createWorkRuntime({
    dir,
    manual: true,
    now: () => 1_700_000_000,
    observe: async (project) => ({ complete: true, origin: project.anchor, agent: project.anchor, radius: 16, blocks: project._blocks || [] }),
    act: async (project, action) => {
      if (action.action === 'place_block') {
        project._blocks = project._blocks || []
        const pos = action.params.pos
        project._blocks = project._blocks.filter((b) => b.x !== pos.x || b.y !== pos.y || b.z !== pos.z)
        project._blocks.push({ x: pos.x, y: pos.y, z: pos.z, block_id: action.params.block_id, state: action.params.state || {} })
      }
      return { ok: true, effect: 'confirmed', operation_id: `tick-${++actSeq}` }
    },
  })
  const cfg = {
    chatroomSeats: [{ id: 'alpha', enabled: true, name: 'Alpha' }, { id: 'beta', enabled: true, name: 'Beta' }],
    gb_minecraft_MC_AGENTS: JSON.stringify([
      { code: 'alpha', name: 'Alpha', enabled: true },
      { code: 'beta', name: 'Beta', enabled: true },
    ]),
  }
  const tools = Object.fromEntries(createWorkTools({ getConfig: () => cfg, runtime }).map((tool) => [tool.name, tool]))
  return { dir, runtime, tools }
}

function seedWarehouse(runtime, projectId) {
  const project = runtime.store.read(projectId)
  for (const item of Object.values(project.materials.items)) {
    if (item.stock < item.gap) item.stock = item.gap
  }
  runtime.store.write(project)
}

test('无席位和代他人都被拒绝，状态回执不含签名密钥', async () => {
  const fx = harness()
  try {
    await assert.rejects(() => fx.tools.mc_work_status.execute({ project_id: 'site' }, {}), /仅限聊天室成员/)
    await fx.tools.mc_blueprint_submit.execute({ project_id: 'site', world_id: 'test-world', ...testSite() }, seat('alpha'))
    seedWarehouse(fx.runtime, 'site')
    await assert.rejects(() => fx.tools.mc_task_claim.execute({ project_id: 'site', task_id: 'floor', member_id: 'beta' }, seat('alpha')), /不能代其他成员/)
    const claimed = await fx.tools.mc_task_claim.execute({ project_id: 'site', task_id: 'floor' }, seat('alpha'))
    assert.equal(claimed.ttl_seconds, 900)
    const status = await fx.tools.mc_work_status.execute({ project_id: 'site' }, seat('alpha'))
    assert.equal(JSON.stringify(status).includes(KEY), false)
    assert.equal(JSON.stringify(status).includes(fx.runtime.key.toString('base64')), false)
    const members = createMembersTools({ getConfig: () => ({}) })
    assert.deepEqual(members.map((tool) => tool.name), ['mc_connect', 'mc_observe', 'mc_act', 'mc_cancel', 'mc_status', 'mc_disconnect', 'mc_takeover', 'mc_resume'])
    const act = members.find((tool) => tool.name === 'mc_act')
    assert.deepEqual(Object.keys(act.parameters.properties), ['action', 'params'])
    assert.equal(workModulesStayOffScheduler(), true)
  } finally {
    fx.runtime.dispose()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('不调用停止时循环继续记步；停止回执含已收到和已停', async () => {
  const fx = harness()
  try {
    await fx.tools.mc_blueprint_submit.execute({ project_id: 'site', world_id: 'test-world', ...testSite() }, seat('alpha'))
    seedWarehouse(fx.runtime, 'site')
    await fx.tools.mc_task_claim.execute({ project_id: 'site', task_id: 'floor' }, seat('alpha'))
    const first = await fx.runtime.tick('site')
    const second = await fx.runtime.tick('site')
    assert.equal(first.paused, undefined)
    assert.equal(second.acted, true)
    assert.ok(fx.runtime.store.read('site').loop.steps >= 2)
    const stopped = await fx.tools.mc_work_stop.execute({ project_id: 'site' }, seat('alpha'))
    assert.equal(stopped.received, true)
    assert.equal(stopped.stopped, true)
    const after = await fx.runtime.tick('site')
    assert.equal(after.paused, 'idle')
    assert.equal(fx.runtime.store.read('site').control.execution, 'stopped')
  } finally {
    fx.runtime.dispose()
    rmSync(fx.dir, { recursive: true, force: true })
  }
})
