/** Acceptance-only A/B loader. Never used by the installed plugin or as a runtime fallback. */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
export async function baselineHost(root) {
  const sourceRoot = resolve(import.meta.dirname, '../src/components/gamebot')
  const backup = resolve(root, 'src/components/gamebot')
  const dataURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  const control = dataURL(readFileSync(resolve(backup, 'mc-control.mjs'), 'utf8'))
  const memory = dataURL(readFileSync(resolve(backup, 'mc-memory.mjs'), 'utf8'))
  const source = readFileSync(resolve(backup, 'mc-host.mjs'), 'utf8').replace(/from '([^']+)'/g, (match, specifier) => {
    if (specifier === './mc-control.mjs') return `from '${control}'`
    if (specifier === './mc-memory.mjs') return `from '${memory}'`
    return specifier.startsWith('.') ? `from '${pathToFileURL(resolve(sourceRoot, specifier)).href}'` : match
  })
  return (await import(dataURL(source))).createMcControlHost
}
