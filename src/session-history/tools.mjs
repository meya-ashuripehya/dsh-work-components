/**
 * Model-facing tools to read official DSH pre-compaction history.
 * Official compaction replaces a surface span with a compact-checkpoint summary;
 * raw append-origin events remain in the session log and are recoverable here.
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import {
  SEARCH_PRE_COMPACTION_NAME,
  eventsFromExec,
  searchPreCompaction,
} from './extract.mjs'

const OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value?.text ?? JSON.stringify(value)) }],
}

export function createPreCompactionHistoryTools() {
  const searchTool = defineTool({
    name: SEARCH_PRE_COMPACTION_NAME,
    description:
      'Search or list original conversation turns that official DSH compaction (/compact or auto pressure) shadowed behind a summary checkpoint. '
      + 'Those raw turns remain in this session\'s append-only log but are absent from the model-visible surface after compaction. '
      + 'Use when you need exact quotes, names, numbers, tool outputs, or decisions that the compaction summary may have dropped. '
      + 'Read-only; current session only. Pass listCheckpoints=true to see compaction ranges first.',
    parameters: {
      query: {
        type: 'string',
        description: 'Keywords to find in shadowed turns. Case-insensitive substring match; whitespace separates terms and every term must appear. Works with Chinese text. May be empty when listCheckpoints or other filters are given.',
      },
      listCheckpoints: {
        type: 'boolean',
        description: 'If true, list compact-checkpoint ranges (seq span, id, summary preview) instead of searching message bodies.',
      },
      role: {
        type: 'string',
        description: 'Optional: only user, assistant, tool, system, or developer.',
      },
      fromSeq: { type: 'integer', description: 'Optional: lowest event seq to include.' },
      toSeq: { type: 'integer', description: 'Optional: highest event seq to include.' },
      compactionId: { type: 'string', description: 'Optional: only messages shadowed by this compactionId.' },
      context: { type: 'integer', description: 'Optional: neighbouring recoverable messages on each side of a hit, 0-3 (default 1).' },
      limit: { type: 'integer', description: 'Optional: maximum hits to return, 1-20 (default 8).' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const events = eventsFromExec(exec)
      if (!events) {
        return { text: 'search_pre_compaction: no live session on this agent (cannot read the event log).', error: true }
      }
      return searchPreCompaction(events, args || {})
    },
  })
  return [searchTool]
}
