/** Read-only preset service for the isolated acceptance harness; never mounts plugins. */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { personaFromComposition } from '../src/dsh-catalog.mjs'

export function readLivePresets(path, requested) {
  const ids = new Set(requested.filter(Boolean))
  const schema = yaml.DEFAULT_SCHEMA.extend(['scalar', 'mapping', 'sequence'].map((kind) =>
    new yaml.Type('tag:yaml.org,2002:js', { kind, construct: () => null })))
  const tree = yaml.load(readFileSync(path, 'utf8'), { schema })
  const documents = new Map()
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (/(^|\/)dsh-agent-preset$/.test(node.name || '') && ids.has(node.config?.id) && node.disabled !== true) {
      const persona = personaFromComposition(yaml.dump(node.config.plugins || []))
      // Only the persona leaves this reader. Tool configs and any credentials stay out.
      documents.set(node.config.id, JSON.stringify([{ name: 'dsh-persona', config: { prefix: persona } }]))
    }
    Object.values(node).forEach(visit)
  }
  visit(tree)
  for (const id of ids) if (!documents.has(id)) throw new Error(`验收预检失败：未找到预设 ${id}`)
  return {
    list: async () => [...documents.keys()].map((id) => ({ id })),
    readDocument: async (id) => {
      if (!documents.has(id)) throw new Error(`未找到预设 ${id}`)
      return { content: documents.get(id) }
    },
  }
}
