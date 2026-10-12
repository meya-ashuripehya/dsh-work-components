/**
 * 钉死的上游提交。棋盘与规则只从这些仓库加载，不并进本仓库。
 * chess-engine 的 v2.4.6 是附注标签，这里记的是剥掉标签后的提交。
 */
export const BOARD_SOURCES = {
  xiangqi: {
    id: 'xiangqi',
    label: '中国象棋',
    repo: 'https://github.com/kongyijilafumi/zh-chess.git',
    commit: '96729d6924a7d496d21ee5aadfe6bb22e1a32449',
  },
  'chess-engine': {
    id: 'chess-engine',
    label: '国际象棋规则',
    repo: 'https://github.com/josefjadrny/js-chess-engine.git',
    commit: '25c8a1f077b81999faa78d504c74ec42639903b1',
  },
  'chess-app': {
    id: 'chess-app',
    label: '国际象棋棋盘',
    repo: 'https://github.com/josefjadrny/js-chess-engine-app.git',
    commit: 'a0e7e1c43e8da87bd80fdd76bfdef405365f47df',
  },
  gomoku: {
    id: 'gomoku',
    label: '五子棋',
    repo: 'https://github.com/ZoliQua/Gomoku-Game.git',
    commit: '01de603474898374c95b51dfd628b7d4e02472ee',
  },
  'go-board': {
    id: 'go-board',
    label: '围棋规则',
    repo: 'https://github.com/SabakiHQ/go-board.git',
    commit: '099cc18c08c99fa2bad9d851d0bd2343e2e0ca4e',
  },
  shudan: {
    id: 'shudan',
    label: '围棋棋盘',
    repo: 'https://github.com/SabakiHQ/Shudan.git',
    commit: 'bf2be30c568338c77294a782742036c1b3167c72',
  },
  deadstones: {
    id: 'deadstones',
    label: '围棋死子估计',
    repo: 'https://github.com/SabakiHQ/deadstones.git',
    commit: 'c40ce84c340d6f4f214fe92b42f939eda213d01d',
  },
}

export const GAMES = {
  xiangqi: { id: 'xiangqi', label: '中国象棋', sources: ['xiangqi'], first: 'red' },
  chess: { id: 'chess', label: '国际象棋', sources: ['chess-engine', 'chess-app'], first: 'white' },
  gomoku: { id: 'gomoku', label: '五子棋', sources: ['gomoku'], first: 'black' },
  go: { id: 'go', label: '围棋', sources: ['go-board', 'shudan', 'deadstones'], first: 'black' },
}

export const GAME_IDS = Object.keys(GAMES)
