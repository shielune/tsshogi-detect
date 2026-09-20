import { describe, expect, test } from 'bun:test'
import { Color, type Move, Record as ShogiRecord } from 'tsshogi'
import { MoveHistory } from '../src/move-history.ts'
import { recordTemplates } from '../src/scan.ts'
import {
  detectStrategies,
  findStrategy,
  KNOWN_STRATEGIES,
  recordStrategies,
} from '../src/strategy.ts'

/**
 * 実戦の序盤 30 手。先手が四間飛車から雁木に組み替え、後手が袖飛車に振る。
 * 5 手目の▲6八飛で四間飛車、28 手目の△7二飛で袖飛車が成立する。
 */
const MOVES =
  '7g7f 3c3d 6g6f 8c8d 2h6h 8d8e 8h7g 7a6b 7i7h 6a5b 5i4h 5a4b 1g1f 4b3b 1f1e 5c5d 3i3h 3a4b 4h3i 4b5c 7h6g 7c7d 3i2h 7d7e 6h7h 7e7f 6g7f 8b7b 7g8h 5c6d'

function play(usiMoves: string): { record: ShogiRecord; moves: Move[]; history: MoveHistory } {
  const record = new ShogiRecord()
  const moves: Move[] = []
  const history = new MoveHistory()
  history.initFromPosition(record.position)
  for (const usi of usiMoves.split(' ')) {
    const move = record.position.createMoveByUSI(usi)
    if (!move) throw new Error(`不正な指し手: ${usi}`)
    history.recordMove(move, moves.length + 1)
    moves.push(move)
    record.append(move)
  }
  return { record, moves, history }
}

const names = (list: readonly { template: { name: string }; side: string }[]): string[] =>
  list.map((entry) => `${entry.template.name}/${entry.side}`)

const namesAt = (
  list: readonly { template: { name: string }; side: string; ply: number }[],
): string[] => list.map((entry) => `${entry.template.name}/${entry.side}@${entry.ply}`)

describe('テンプレート', () => {
  test('assets/shogi/strategies.txt の全件が載っている', () => {
    expect(KNOWN_STRATEGIES.length).toBe(244)
  })

  test('名前と別名の両方で引ける', () => {
    expect(findStrategy('四間飛車')?.name).toBe('四間飛車')
    expect(findStrategy('横歩取り△8五飛')?.name).toBe('中座飛車')
    expect(findStrategy('存在しない戦法')).toBeUndefined()
  })

  test('盤の形を持たない分類の節がある', () => {
    const categories = KNOWN_STRATEGIES.filter((template) => template.category)
    expect(categories.map((template) => template.name)).toContain('振り飛車')
    for (const template of categories) expect(template.placements).toEqual([])
  })
})

describe('detectStrategies', () => {
  /** 雁木が組み上がった 21 手目の局面。盤の形だけで立つ戦法の見本。 */
  const GANGI = MOVES.split(' ').slice(0, 21).join(' ')

  test('局面から戦法を検出する', () => {
    const { record } = play(GANGI)
    expect(names(detectStrategies(record.position))).toEqual(['雁木戦法/black'])
  })

  test('陣営を指定すると片側だけ返す', () => {
    const { record } = play(GANGI)
    expect(detectStrategies(record.position, Color.BLACK)).toHaveLength(1)
    expect(detectStrategies(record.position, Color.WHITE)).toHaveLength(0)
  })

  test('最終手や手数に条件を持つ戦法は局面だけでは検出できない', () => {
    const { record, history } = play(GANGI)
    // 四間飛車は「2 八から 6 八へ振った手」が要件なので、局面照合では立たない。
    // 履歴を渡しても同じで、この手を見るには recordStrategies が要る
    expect(names(detectStrategies(record.position, undefined, history))).not.toContain(
      '四間飛車/black',
    )
    expect(namesAt(recordStrategies(play(GANGI).moves))).toContain('四間飛車/black@5')
  })
})

describe('recordStrategies', () => {
  test('初めて成立した手数を返す', () => {
    const { moves } = play(MOVES)
    expect(namesAt(recordStrategies(moves))).toEqual([
      '振り飛車/black@5',
      '四間飛車/black@5',
      '居飛車/black@21',
      '雁木戦法/black@21',
      'ノーマル四間飛車/black@23',
      'その他/white@28',
      '袖飛車/white@28',
    ])
  })

  test('分類の節は子と同じ手数で巻き上がる', () => {
    const { moves } = play(MOVES)
    const detected = recordStrategies(moves)
    const rolled = detected.find((entry) => entry.template.name === '振り飛車')
    const child = detected.find((entry) => entry.template.name === '四間飛車')
    expect(rolled?.ply).toBe(child?.ply as number)
  })

  test('成立を認めるのは指した側だけ', () => {
    // ▲3六歩は先手の「初手▲3六歩戦法」。後手視点で同じ形を見ると「2手目△7四歩戦法」に
    // 見えてしまうので、指した側に絞らないと 2 手目の先手にこれが付く
    const { moves } = play('3g3f 3c3d')
    expect(namesAt(recordStrategies(moves))).toEqual([
      'その他/black@1',
      '初手▲3六歩戦法/black@1',
    ])
    const loose = recordTemplates(KNOWN_STRATEGIES, moves, { requireParent: true })
    expect(namesAt(loose)).toContain('2手目△7四歩戦法/black@2')
  })

  test('同じ戦法は最初の 1 回だけ報告する', () => {
    const { moves } = play(MOVES)
    const keys = recordStrategies(moves).map((entry) => `${entry.template.name}|${entry.side}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('指し手が無ければ何も返さない', () => {
    expect(recordStrategies([])).toEqual([])
  })
})
