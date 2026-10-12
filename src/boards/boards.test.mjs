import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardsFeature } from './index.mjs'
import { ensureSource, gameStatus, sourceDir } from './download.mjs'
import { openGo } from './engines/go.mjs'
import { openGomoku } from './engines/gomoku.mjs'
import { openXiangqi } from './engines/xiangqi.mjs'
import { assertMitLicense, isMitLicense, readLicenseText } from './license.mjs'
import { humanMovePrompt, playerName } from './names.mjs'
import { closeSession, openSession, playSession, resetSession } from './session.mjs'
import { BOARD_SOURCES, GAMES } from './sources.mjs'
import { createBoardsTools } from './tools.mjs'

const MIRROR = join(tmpdir(), 'dsh-boards-src')
const FOLDERS = {
  xiangqi: 'zh-chess',
  'chess-engine': 'js-chess-engine',
  'chess-app': 'js-chess-engine-app',
  gomoku: 'gomoku',
  'go-board': 'go-board',
  shudan: 'shudan',
  deadstones: 'deadstones',
}

const MIT = `MIT License

Copyright (c) 2026 Test

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software to deal in the Software without restriction.
`

function git(args, cwd) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'boards-test',
      GIT_AUTHOR_EMAIL: 'boards-test@example.com',
      GIT_COMMITTER_NAME: 'boards-test',
      GIT_COMMITTER_EMAIL: 'boards-test@example.com',
    },
  })
}

async function emptyDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

function placeSources(root) {
  mkdirSync(join(root, 'boards', 'src'), { recursive: true })
  for (const [id, folder] of Object.entries(FOLDERS)) {
    const from = join(MIRROR, folder)
    const dest = sourceDir(root, id)
    cpSync(from, dest, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).includes('.git'),
    })
    writeFileSync(join(root, 'boards', 'src', `${id}.commit`), BOARD_SOURCES[id].commit + '\n', 'utf8')
  }
}

function blank(n) {
  return Array.from({ length: n }, () => Array(n).fill(0))
}

test('download status is one row per game', async () => {
  const root = await emptyDir('dsh-boards-status-')
  try {
    const empty = gameStatus(root)
    assert.deepEqual(empty.map((game) => game.id), ['xiangqi', 'chess', 'gomoku', 'go'])
    assert.equal(empty.every((game) => game.ready === false), true)
    for (const id of GAMES.chess.sources) {
      const dir = sourceDir(root, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'LICENSE'), MIT, 'utf8')
      writeFileSync(join(root, 'boards', 'src', `${id}.commit`), BOARD_SOURCES[id].commit + '\n', 'utf8')
    }
    const chessReady = gameStatus(root)
    assert.equal(chessReady.find((game) => game.id === 'chess').ready, true)
    assert.equal(chessReady.find((game) => game.id === 'go').ready, false)
    const partial = GAMES.go.sources[0]
    const goDir = sourceDir(root, partial)
    mkdirSync(goDir, { recursive: true })
    writeFileSync(join(goDir, 'LICENSE'), MIT, 'utf8')
    writeFileSync(join(root, 'boards', 'src', `${partial}.commit`), BOARD_SOURCES[partial].commit + '\n', 'utf8')
    assert.equal(gameStatus(root).find((game) => game.id === 'go').ready, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('names, license, engines, one session', async () => {
  assert.equal(playerName(''), 'user')
  assert.equal(playerName('   '), 'user')
  assert.equal(playerName(' Shiro '), 'Shiro')
  assert.equal(humanMovePrompt('  ', '车1进1'), 'user下在了车1进1,现在是你的回合')
  assert.equal(humanMovePrompt('Shiro', 'e2e4'), 'Shiro下在了e2e4,现在是你的回合')
  assert.equal(isMitLicense('GNU GENERAL PUBLIC LICENSE'), false)
  assert.equal(isMitLicense(MIT), true)

  const origin = await emptyDir('dsh-boards-origin-')
  const badOrigin = await emptyDir('dsh-boards-bad-')
  const root = await emptyDir('dsh-boards-data-')
  try {
    writeFileSync(join(origin, 'LICENSE'), MIT, 'utf8')
    git(['init'], origin)
    git(['add', 'LICENSE'], origin)
    git(['commit', '-m', 'mit'], origin)
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' }).trim()
    const installed = await ensureSource(root, { id: 'sample', label: '样例', repo: origin, commit: sha })
    assertMitLicense(installed)
    assert.equal(readLicenseText(installed).includes('MIT License'), true)
    await ensureSource(root, { id: 'sample', label: '样例', repo: origin, commit: sha })

    writeFileSync(join(badOrigin, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\n', 'utf8')
    git(['init'], badOrigin)
    git(['add', 'LICENSE'], badOrigin)
    git(['commit', '-m', 'gpl'], badOrigin)
    const badSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: badOrigin, encoding: 'utf8' }).trim()
    await assert.rejects(
      () => ensureSource(root, { id: 'rejected', label: '拒绝', repo: badOrigin, commit: badSha }),
      /MIT/,
    )

    placeSources(root)
    resetSession()

    const xiangqi = openXiangqi(sourceDir(root, 'xiangqi'))
    const before = xiangqi.view().fen
    xiangqi.play('炮2平5')
    assert.match(xiangqi.view().fen, /4C2C1/)
    assert.throws(() => xiangqi.play('4,9-4,7'), /合法/)
    const fresh = openXiangqi(sourceDir(root, 'xiangqi'))
    assert.equal(fresh.view().fen, before)
    assert.throws(() => fresh.play('4,9-4,7'), /合法/)
    assert.equal(fresh.view().fen, before)

    const tools = createBoardsTools({ root, getConfig: () => ({ boardsPlayerName: '  ' }) })
    const by = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    const opened = await by.board_open.execute({ game: 'chess', aiSide: 'white' })
    assert.equal(opened.playerName, 'user')
    assert.equal(opened.turn, 'ai')
    await assert.rejects(() => by.board_play.execute({ move: 'e2e5' }), /合法/)
    const played = await by.board_play.execute({ move: 'e2e4' })
    assert.equal(played.turn, 'human')
    assert.equal(played.board.pieces.E4 || played.board.pieces.e4, 'P')
    await assert.rejects(() => by.board_open.execute({ game: 'xiangqi', aiSide: 'black' }), /已经有一局/)
    assert.equal(closeSession().closed, true)
    const again = await by.board_open.execute({ game: 'xiangqi', aiSide: 'black' })
    assert.equal(again.turn, 'human')
    const human = await playSession('炮2平5', 'human')
    assert.equal(human.prompt, 'user下在了炮2平5,现在是你的回合')
    closeSession()

    const gomoku = await openGomoku(sourceDir(root, 'gomoku'), root)
    await gomoku.play('A1')
    assert.throws(() => gomoku.play('A1'), /合法/)
    const line = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'E1']
    const game = await openGomoku(sourceDir(root, 'gomoku'), root)
    for (const move of line) await game.play(move)
    assert.equal(game.view().over.winner, 'black')
    assert.equal(game.view().over.reason, '五连')

    const goDir = sourceDir(root, 'go-board')
    const suicide = blank(5)
    suicide[1][2] = -1
    suicide[2][1] = -1
    suicide[2][3] = -1
    suicide[3][2] = -1
    const strictGo = openGo(goDir, { strict: true, signMap: suicide, turn: 1 })
    await assert.rejects(() => strictGo.play('C3'), /合法/)
    const looseGo = openGo(goDir, { strict: false, signMap: suicide.map((row) => row.slice()), turn: 1 })
    await looseGo.play('C3')

    const ko = blank(19)
    for (const [x, y] of [[0, 1], [1, 0], [1, 2], [2, 1]]) ko[y][x] = 1
    for (const [x, y] of [[2, 0], [2, 2], [3, 1]]) ko[y][x] = -1
    const strictKo = openGo(goDir, { strict: true, signMap: ko, turn: -1 })
    await strictKo.play('B18')
    await assert.rejects(() => strictKo.play('C18'), /合法/)
    const looseKo = openGo(goDir, { strict: false, signMap: ko.map((row) => row.slice()), turn: -1 })
    await looseKo.play('B18')
    await looseKo.play('C18')

    resetSession()
    let cfg = { boardsEnabled: false }
    const registered = []
    const feature = createBoardsFeature({
      logger: { warn() {} },
      plugin(def) {
        def.apply({ inject(_deps, fn) { fn({ tools: { register(tool) { registered.push(tool.name) } } }) } })
        return { dispose() {} }
      },
    }, () => cfg)
    await feature.sync()
    assert.equal(feature.state().status, 'off')
    assert.equal(registered.length, 0)
    cfg = { boardsEnabled: true }
    await feature.sync()
    assert.equal(feature.state().status, 'on')
    assert.deepEqual(registered, ['board_open', 'board_look', 'board_play', 'board_close'])
    await feature.dispose()
  } finally {
    resetSession()
    await rm(origin, { recursive: true, force: true })
    await rm(badOrigin, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
