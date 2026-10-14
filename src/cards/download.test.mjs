import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { contextKey } from './context.mjs'
import { ensureGame, ensureSource, gameStatus } from './download.mjs'
import { classifyLicense } from './license.mjs'
import { cardCode, replay } from './rules.mjs'
import { closeSession, resetSession, saveFileFor } from './session.mjs'
import { CARD_SOURCES } from './sources.mjs'
import { createCardsTools } from './tools.mjs'
import { assertGameSources } from './upstream.mjs'

const MIT = `MIT License

Copyright (c) 2026 Test

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software to deal in the Software without restriction.
`

const JUDGER = `
self.rank2score = {"A":11, "2":2, "3":3, "4":4, "5":5, "6":6, "7":7, "8":8, "9":9, "T":10, "J":10, "Q":10, "K":10}
def judge_score(self, cards):
    score = 0
    count_a = 0
    if score > 21 and count_a:
        score = score - 10
`

const GAME = `
while self.judger.judge_score(self.dealer.hand) < 17:
    pass
dealer_hand = [c.get_index() for c in self.dealer.hand[1:]]
next_state['actions'] = ('hit', 'stand')
`

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'cards-test',
      GIT_AUTHOR_EMAIL: 'cards-test@example.com',
      GIT_COMMITTER_NAME: 'cards-test',
      GIT_COMMITTER_EMAIL: 'cards-test@example.com',
    },
  })
}

function placeRules(dir) {
  const game = join(dir, 'rlcard', 'games', 'blackjack')
  mkdirSync(game, { recursive: true })
  writeFileSync(join(game, 'judger.py'), JUDGER, 'utf8')
  writeFileSync(join(game, 'game.py'), GAME, 'utf8')
}

test('license gate and pinned RLCard checkout, then card_open without the network', async () => {
  assert.equal(classifyLicense(MIT), 'MIT')
  assert.equal(classifyLicense('Apache License\nVersion 2.0, January 2004\n'), 'Apache-2.0')
  assert.equal(classifyLicense('BSD 3-Clause License\n'), 'BSD')
  assert.equal(classifyLicense('ISC License\n'), 'ISC')
  assert.equal(classifyLicense('GNU GENERAL PUBLIC LICENSE\n'), '')
  assert.equal(classifyLicense('MIT License\nGNU GENERAL PUBLIC LICENSE\n'), '')
  assert.equal(classifyLicense(''), '')

  const origin = await mkdtemp(join(tmpdir(), 'dsh-cards-origin-'))
  const gpl = await mkdtemp(join(tmpdir(), 'dsh-cards-gpl-'))
  const bare = await mkdtemp(join(tmpdir(), 'dsh-cards-bare-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-cards-data-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  try {
    writeFileSync(join(origin, 'LICENSE'), MIT, 'utf8')
    placeRules(origin)
    git(['init'], origin)
    git(['add', '.'], origin)
    git(['commit', '-m', 'mit'], origin)
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' }).trim()
    const installed = await ensureSource({ id: 'rlcard', label: 'RLCard', repo: origin, commit: sha, license: 'MIT' })
    assert.equal(readFileSync(join(installed, 'LICENSE'), 'utf8').includes('MIT License'), true)
    await ensureSource({ id: 'rlcard', label: 'RLCard', repo: 'https://github.com/datamllab/rlcard.git', commit: sha, license: 'MIT' })

    writeFileSync(join(gpl, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\n', 'utf8')
    placeRules(gpl)
    git(['init'], gpl)
    git(['add', '.'], gpl)
    git(['commit', '-m', 'gpl'], gpl)
    const gplSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gpl, encoding: 'utf8' }).trim()
    await assert.rejects(
      () => ensureSource({ id: 'gpl-sample', label: '拒绝', repo: gpl, commit: gplSha, license: 'MIT' }),
      /许可证/,
    )

    writeFileSync(join(bare, 'LICENSE'), MIT, 'utf8')
    git(['init'], bare)
    git(['add', 'LICENSE'], bare)
    git(['commit', '-m', 'bare'], bare)
    const bareSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: bare, encoding: 'utf8' }).trim()
    const bareDir = await ensureSource({ id: 'rlcard', label: 'RLCard', repo: bare, commit: bareSha, license: 'MIT' })
    assert.throws(() => assertGameSources(bareDir, 'blackjack'), /二十一点/)

    const pin = CARD_SOURCES.rlcard.commit
    const pinned = join(root, 'cards', 'src', 'rlcard')
    mkdirSync(join(pinned, 'rlcard', 'games', 'blackjack'), { recursive: true })
    // 上游 RLCard 实际是 LICENSE.md；状态检查必须认它
    writeFileSync(join(pinned, 'LICENSE.md'), MIT, 'utf8')
    writeFileSync(join(pinned, 'rlcard', 'games', 'blackjack', 'judger.py'), JUDGER, 'utf8')
    writeFileSync(join(pinned, 'rlcard', 'games', 'blackjack', 'game.py'), GAME, 'utf8')
    mkdirSync(join(root, 'cards', 'src'), { recursive: true })
    writeFileSync(join(root, 'cards', 'src', 'rlcard.commit'), pin + '\n', 'utf8')
    const status = gameStatus()
    assert.equal(status[0].id, 'blackjack')
    assert.equal(status[0].ready, true)
    assert.equal(status[0].license, 'MIT')
    assert.equal(status[0].repo, 'https://github.com/datamllab/rlcard')
    assert.equal(status[0].commit, pin)
    const byId = Object.fromEntries(status.map((item) => [item.id, item.ready]))
    assert.equal(byId.blackjack, true)
    assert.equal(byId.leduc, false)
    assert.equal(byId['limit-holdem'], false)
    assert.equal(byId.uno, false)
    assert.equal(byId.doudizhu, false)

    const tools = Object.fromEntries(createCardsTools({ getConfig: () => ({ cardsPlayerName: 'Shiro' }) }).map((tool) => [tool.name, tool]))
    const view = await tools.card_open.execute({}, { agent: { id: 'solo' } })
    assert.equal(view.playerName, 'Shiro')
    assert.equal(view.game, 'blackjack')
    const key = contextKey({ sessionId: 'solo' })
    const saved = JSON.parse(readFileSync(saveFileFor(key), 'utf8'))
    const state = replay(saved.seed, saved.actions)
    const hole = cardCode(state.dealer[1])
    assert.equal(saved.player, undefined)
    assert.equal(JSON.stringify(saved).includes('"rank"'), false)
    assert.equal(JSON.stringify(view.dealer).includes(hole), view.revealed === true)
    assert.equal(closeSession(key).closed, true)

    const stub = (rel, text) => {
      const file = join(pinned, ...rel.split('/'))
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text, 'utf8')
    }
    stub('rlcard/games/leducholdem/dealer.py', "Card('H', 'K')\nCard('S', 'J')\n")
    stub('rlcard/games/leducholdem/game.py', 'allowed_raise_num = 2\nsmall_blind = 1\n')
    stub('rlcard/games/leducholdem/judger.py', 'hand.rank == public_card.rank\n')
    stub('rlcard/games/limitholdem/game.py', 'allowed_raise_num = 4\nsmall_blind = 1\nround_counter <= 2\n')
    stub('rlcard/games/limitholdem/utils.py', 'def compare_hands\n')
    stub('rlcard/games/uno/game.py', 'deal_cards(player, 7)\nnum_players=2\n')
    stub('rlcard/games/uno/round.py', 'wild_draw_4\n')
    stub('rlcard/games/doudizhu/dealer.py', "players[0].role = 'landlord'\n")
    stub('rlcard/games/doudizhu/judger.py', 'def playable_cards_from_hand\n')
    stub("rlcard/games/doudizhu/utils.py", "CARD_RANK_STR = ['A', '2', 'B', 'R']\n")
    const ready = Object.fromEntries(gameStatus().map((item) => [item.id, item.ready]))
    assert.deepEqual(ready, { blackjack: true, leduc: true, 'limit-holdem': true, uno: true, doudizhu: true })
    await ensureGame('uno')
  } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(origin, { recursive: true, force: true })
    await rm(gpl, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('规则源状态：认上游的 LICENSE.md 与 `score -= 10` 写法', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { hasLicenseFile } = await import('./license.mjs')
  const { assertBlackjackSources } = await import('./upstream.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cards-upstream-'))
  try {
    assert.equal(hasLicenseFile(dir), false)
    writeFileSync(join(dir, 'LICENSE.md'), MIT, 'utf8')
    assert.equal(hasLicenseFile(dir), true)
    mkdirSync(join(dir, 'rlcard', 'games', 'blackjack'), { recursive: true })
    const upstream = JUDGER.replace(/score\s*=\s*score\s*-\s*10/, 'score -= 10')
    assert.equal(upstream.includes('score -= 10'), true)
    writeFileSync(join(dir, 'rlcard', 'games', 'blackjack', 'judger.py'), upstream, 'utf8')
    writeFileSync(join(dir, 'rlcard', 'games', 'blackjack', 'game.py'), GAME, 'utf8')
    assert.doesNotThrow(() => assertBlackjackSources(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
