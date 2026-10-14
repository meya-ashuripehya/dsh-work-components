import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CardError } from './errors.mjs'

/** 钉死版本里必须能核对到的二十一点规则。对不上就拒绝，避免装进另一套牌规。 */
export function assertBlackjackSources(dir) {
  const judgerPath = join(dir, 'rlcard', 'games', 'blackjack', 'judger.py')
  const gamePath = join(dir, 'rlcard', 'games', 'blackjack', 'game.py')
  if (!existsSync(judgerPath) || !existsSync(gamePath)) {
    throw new CardError('该版本没有 RLCard 二十一点规则，已拒绝装载')
  }
  const judger = readFileSync(judgerPath, 'utf8')
  const game = readFileSync(gamePath, 'utf8')
  const table = judger.match(/rank2score\s*=\s*\{([^}]+)\}/)
  const scores = {}
  if (table) {
    for (const part of table[1].split(',')) {
      const hit = part.match(/["']([A2-9TJQK])["']\s*:\s*(\d+)/)
      if (hit) scores[hit[1]] = Number(hit[2])
    }
  }
  if (scores.A !== 11 || scores.T !== 10 || scores.K !== 10 || scores.J !== 10 || scores.Q !== 10) {
    throw new CardError('RLCard 点数表不是二十一点（A 为 11，十与花牌为 10），已拒绝装载')
  }
  if (!/score\s*-=?\s*10/.test(judger) || !/count_a/.test(judger)) {
    throw new CardError('RLCard 没有在爆牌时把 A 从 11 改计为 1，已拒绝装载')
  }
  const stand = game.match(/judge_score\(self\.dealer\.hand\)\s*<\s*(\d+)/)
  if (!stand || Number(stand[1]) !== 17) {
    throw new CardError('RLCard 不是「庄家不足 17 点必须要牌」，已拒绝装载')
  }
  if (!game.includes("'hit'") && !game.includes('"hit"')) throw new CardError('RLCard 二十一点没有 hit，已拒绝装载')
  if (!game.includes("'stand'") && !game.includes('"stand"')) throw new CardError('RLCard 二十一点没有 stand，已拒绝装载')
  if (!/dealer\.hand\[1:\]/.test(game)) throw new CardError('RLCard 没有在终局前藏起一张庄家牌，已拒绝装载')
  return { scores, standAt: 17 }
}

function mustInclude(dir, relative, fragment, message) {
  const file = join(dir, ...relative.split('/'))
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes(fragment)) {
    throw new CardError(message)
  }
}

/** 按游戏核对钉死版本里的规则片段。许可证通过后，缺哪一种牌就只拒绝那一种。 */
export function assertGameSources(dir, game) {
  if (game === 'blackjack') return assertBlackjackSources(dir)
  if (game === 'leduc') {
    mustInclude(dir, 'rlcard/games/leducholdem/dealer.py', "Card('H', 'K')", '该版本没有勒杜克的 6 张牌组，已拒绝装载')
    mustInclude(dir, 'rlcard/games/leducholdem/dealer.py', "Card('S', 'J')", '该版本没有勒杜克的 6 张牌组，已拒绝装载')
    mustInclude(dir, 'rlcard/games/leducholdem/game.py', 'allowed_raise_num = 2', '该版本不是每轮最多两次加注的勒杜克，已拒绝装载')
    mustInclude(dir, 'rlcard/games/leducholdem/game.py', 'small_blind = 1', '该版本不是小盲为 1 的勒杜克，已拒绝装载')
    mustInclude(dir, 'rlcard/games/leducholdem/judger.py', 'hand.rank == public_card.rank', '该版本没有勒杜克对子判定，已拒绝装载')
    return { game }
  }
  if (game === 'limit-holdem') {
    mustInclude(dir, 'rlcard/games/limitholdem/game.py', 'allowed_raise_num = 4', '该版本不是每轮最多四次加注的限注德州，已拒绝装载')
    mustInclude(dir, 'rlcard/games/limitholdem/game.py', 'small_blind = 1', '该版本不是小盲为 1 的限注德州，已拒绝装载')
    mustInclude(dir, 'rlcard/games/limitholdem/game.py', 'round_counter <= 2', '该版本没有限注德州的四轮街道，已拒绝装载')
    mustInclude(dir, 'rlcard/games/limitholdem/utils.py', 'def compare_hands', '该版本没有限注德州的摊牌比较，已拒绝装载')
    return { game }
  }
  if (game === 'uno') {
    mustInclude(dir, 'rlcard/games/uno/game.py', 'deal_cards(player, 7)', '该版本不是每人 7 张的 UNO，已拒绝装载')
    mustInclude(dir, 'rlcard/games/uno/game.py', 'num_players=2', '该版本不是两人 UNO，已拒绝装载')
    mustInclude(dir, 'rlcard/games/uno/round.py', 'wild_draw_4', '该版本没有 UNO 的 +4，已拒绝装载')
    return { game }
  }
  if (game === 'doudizhu') {
    mustInclude(dir, 'rlcard/games/doudizhu/dealer.py', "players[0].role = 'landlord'", '该版本不是玩家为地主的斗地主，已拒绝装载')
    mustInclude(dir, 'rlcard/games/doudizhu/judger.py', 'def playable_cards_from_hand', '该版本没有斗地主可出牌生成，已拒绝装载')
    mustInclude(dir, 'rlcard/games/doudizhu/utils.py', "'A', '2', 'B', 'R'", '该版本没有斗地主的大小王牌序，已拒绝装载')
    return { game }
  }
  throw new CardError('未知的牌类')
}
