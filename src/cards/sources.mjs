/**
 * 牌类规则源。一份 RLCard 检出覆盖全部牌类，源码不随插件分发。
 * 设置页下载钉死提交，许可证必须与 license 一致且属于可接受的宽松许可证。
 * 每种游戏另有自己的关键规则片段校验；对不上就拒绝开那一种牌。
 * 插件自己发牌、判合法动作、走对手，不调用 RLCard 的智能体。
 *
 * 与钉死版本对齐、并在 README 里写明的差异：二十一点区分天成，玩家爆牌后庄家不再补牌；
 * 勒杜克双方都和对子时平分；UNO 支持 2 至 10 人并按官方规则处理跳过、反转与 +2/+4（旧版两人存档仍按上游两人局重放），摸牌自动打出沿用上游；
 * 限注德州不做无限注；斗地主玩家固定为地主，没有叫分，底牌公开。
 */
export const CARD_SOURCES = {
  rlcard: {
    id: 'rlcard',
    label: 'RLCard',
    repo: 'https://github.com/datamllab/rlcard.git',
    page: 'https://github.com/datamllab/rlcard',
    commit: 'd7d0a957baf4cc7225a50522adb0164bf130a9d0',
    license: 'MIT',
  },
}

export const GAMES = {
  blackjack: {
    id: 'blackjack',
    label: '二十一点',
    sources: ['rlcard'],
    note: '一副牌，A 按 1 或 11，庄家软硬 17 都停。玩家爆牌庄家不再补牌；双方起手 21 算天成。没有分牌、加倍和保险。',
  },
  leduc: {
    id: 'leduc',
    label: '勒杜克扑克',
    sources: ['rlcard'],
    note: '6 张牌、两人对决、两轮限注。小盲先行动，每轮最多加注两次，公开牌后加注额加倍。双方都和对子时平分。',
  },
  'limit-holdem': {
    id: 'limit-holdem',
    label: '限注德州扑克',
    sources: ['rlcard'],
    note: '两人对决、四轮限注。翻牌前小盲先行动，翻牌后加注额加倍，每轮最多加注四次。摊牌取七张里最好的五张。不提供无限注。',
  },
  uno: {
    id: 'uno',
    label: 'UNO',
    sources: ['rlcard'],
    note: '2 至 10 人，默认 4 人，人数在上方设置。颜色或点数相同即可出牌，万能牌须指定颜色。跳过令下家停一轮；反转改变出牌方向，两人局中等同跳过；+2 与 +4 令下家摸牌并停一轮。仅在没有其他可出的牌时方可出 +4。摸到同色牌或万能牌会立即打出。',
  },
  doudizhu: {
    id: 'doudizhu',
    label: '斗地主',
    sources: ['rlcard'],
    note: '三人。玩家固定为地主，两名对手为农民，没有叫分。底牌公开。炸弹压普通牌，火箭最大。',
  },
}

export const GAME_IDS = Object.keys(GAMES)
