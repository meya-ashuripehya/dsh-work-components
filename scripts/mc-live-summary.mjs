/** Summarize isolated public traces; never reads private message bodies or credentials. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2])
const rows = readFileSync(join(root, 'minecraft-control-trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const summary = {
  observedAt: new Date().toISOString(),
  seats: [...new Set(rows.map((r) => r.memberId))].filter(Boolean).map((id) => {
    const events = rows.filter((r) => r.memberId === id)
    const models = events.filter((r) => r.event === 'model.done').map((r) => r.elapsedMs).sort((a, b) => a - b)
    return { id, first: events[0]?.ts, latest: events.at(-1)?.ts,
      completed: events.filter((r) => r.event === 'runTurn.end').length,
      errors: events.filter((r) => r.event === 'runTurn.error').length,
      verifiedMoves: events.filter((r) => r.event === 'action.done' && r.action === 'move_to' && r.ok && r.verified).length,
      failedMoves: events.filter((r) => r.event === 'action.done' && r.action === 'move_to' && !r.ok).length,
      publicOrPrivateSpeechActions: events.filter((r) => r.event === 'action.done' && r.action === 'say' && r.ok).length,
      modelMedianMs: models[Math.floor(models.length / 2)], modelMaxMs: models.at(-1) }
  }),
}
const { id } = JSON.parse(readFileSync(join(root, 'live-room.json'), 'utf8'))
const publicMessages = readFileSync(join(root, 'chatroom', 'rooms', id, 'messages.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((m) => m.source === 'minecraft')
summary.mirrors = { count: publicMessages.length, unique: new Set(publicMessages.map((m) => m.mcMessageId)).size, blank: publicMessages.filter((m) => !m.text?.trim()).length }
writeFileSync(join(root, 'live-summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
