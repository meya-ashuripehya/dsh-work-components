import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ID_RE } from './model.mjs'
import { dataDir } from '../../../tools.mjs'
import { migrateProject, storageFileName, parseStorageFileName } from './migrate.mjs'

const fs = { writeFileSync, renameSync, rmSync }

export function workDir() {
  return join(dataDir(), 'minecraft-work')
}

/** 先写临时文件再替换。替换失败时删掉临时文件，原文件保持不变。 */
export function commitJson(file, value, io = fs) {
  const text = JSON.stringify(value, null, 2) + '\n'
  const tmp = `${file}.${process.pid}.tmp`
  io.writeFileSync(tmp, text, 'utf8')
  try {
    io.renameSync(tmp, file)
  } catch (error) {
    try { io.rmSync(tmp, { force: true }) } catch { /* 临时文件清不掉也不覆盖原文件 */ }
    throw error
  }
}

export function ensureClaimKey(dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'claim.key')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64') + '\n', 'utf8')
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
}

export function createStore(dir) {
  mkdirSync(dir, { recursive: true })
  const tails = new Map()

  function pathOf(id, worldId = null) {
    if (!ID_RE.test(id)) throw new Error('项目 id 无效')
    return join(dir, storageFileName(worldId, id))
  }

  function resolveFile(id, worldId = null) {
    if (worldId) return pathOf(id, worldId)
    const scoped = readdirSync(dir).filter((name) => name.endsWith(`__${id}.json`))
    if (scoped.length === 1) return join(dir, scoped[0])
    const legacy = join(dir, `${id}.json`)
    if (existsSync(legacy)) return legacy
    return pathOf(id, null)
  }

  function read(id, worldId = null) {
    const file = resolveFile(id, worldId)
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    try {
      return migrateProject(JSON.parse(text))
    } catch {
      const error = new Error('项目文件损坏')
      error.code = 'corrupt'
      throw error
    }
  }

  function write(project) {
    if (!project || !ID_RE.test(project.id)) throw new Error('项目 id 无效')
    mkdirSync(dir, { recursive: true })
    commitJson(pathOf(project.id, project.world_id), project)
  }

  function update(id, fn, worldId = null) {
    const tailKey = `${worldId || ''}:${id}`
    const prev = tails.get(tailKey) || Promise.resolve()
    const run = prev.then(async () => {
      const current = read(id, worldId)
      const result = await fn(current)
      if (result?.project) write(result.project)
      return result
    })
    tails.set(tailKey, run.then(() => {}, () => {}))
    return run
  }

  return { dir, pathOf, read, write, update, parseStorageFileName }
}
