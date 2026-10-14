import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCardsFeature } from './index.mjs'
import { resetSession } from './session.mjs'

test('cardsEnabled registers the five card tools and nothing when it is off', async () => {
  const registered = []
  let cfg = { cardsEnabled: false }
  const feature = createCardsFeature({
    logger: { warn() {} },
    plugin(def) {
      def.apply({
        inject(_deps, fn) {
          fn({ tools: { register(tool) { registered.push(tool.name) } } })
        },
      })
      return { dispose() {} }
    },
  }, () => cfg)
  try {
    await feature.sync()
    assert.deepEqual(registered, [])
    cfg = { cardsEnabled: true }
    await feature.sync()
    assert.deepEqual(registered, ['card_open', 'card_look', 'card_play', 'card_close', 'card_reset'])
  } finally {
    await feature.dispose()
    resetSession()
  }
})
