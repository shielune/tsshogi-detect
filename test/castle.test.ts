import { describe, expect, test } from 'bun:test'
import { Color, type Move, Record as ShogiRecord } from 'tsshogi'
import {
  detectCastles,
  findCastle,
  hasHistoryRequirement,
  hasPlyConstraint,
  KNOWN_CASTLES,
  matchesTemplate,
  recordCastles,
} from '../src/castle.ts'

/** 実戦の序盤 30 手。28 手目に後手の片美濃囲いが成立する。 */
const MOVES =
  '7g7f 3c3d 2g2f 5c5d 3i4h 5d5e 5i6h 8b5b 6h7h 5a6b 7i6h 6b7b 4i5h 7b8b 2f2e 2b3c 6h7g 5e5f 5g5f 5b5f 6g6f 5f5a 6f6e 3a4b 7g6f 4b5c 4h5g 7a7b 5h6g 5c5d'

function play(usiMoves: string): { record: ShogiRecord; moves: Move[] } {
  const record = new ShogiRecord()
  const moves: Move[] = []
  for (const usi of usiMoves.split(' ')) {
    const move = record.position.createMoveByUSI(usi)
    if (!move) throw new Error(`不正な指し手: ${usi}`)
    moves.push(move)
    record.append(move)
  }
  return { record, moves }
}

describe('テンプレート', () => {
  test('assets/shogi/castles.txt の全件が載っている', () => {
    expect(KNOWN_CASTLES.length).toBe(113)
  })

  test('名前と別名の両方で引ける', () => {
    expect(findCastle('金矢倉')?.name).toBe('金矢倉')
    expect(findCastle('存在しない囲い')).toBeUndefined()
  })

  test('要件は先手視点で持つ', () => {
    const template = findCastle('金矢倉')
    expect(template?.placements.length).toBe(7)
  })
})

describe('detectCastles', () => {
  test('局面から囲いを検出する', () => {
    const { record } = play(MOVES)
    const names = detectCastles(record.position).map((d) => `${d.template.name}/${d.side}`)
    expect(names).toEqual(['片美濃囲い/white'])
  })

  test('陣営を指定すると片側だけ返す', () => {
    const { record } = play(MOVES)
    expect(detectCastles(record.position, Color.BLACK)).toHaveLength(0)
    expect(detectCastles(record.position, Color.WHITE)).toHaveLength(1)
  })

  test('ply 制約付きと game-end 評価のテンプレは検出対象外', () => {
    const { record } = play(MOVES)
    const detected = detectCastles(record.position)
    for (const { template } of detected) {
      expect(hasPlyConstraint(template)).toBe(false)
      expect(template.evaluateAtGameEnd ?? false).toBe(false)
    }
  })

  test('履歴要件は履歴を渡さないと成立しない', () => {
    const { record } = play(MOVES)
    const historyBound = KNOWN_CASTLES.filter(hasHistoryRequirement)
    expect(historyBound.length).toBeGreaterThan(0)
    for (const template of historyBound) {
      expect(matchesTemplate(record.position, template, Color.BLACK)).toBe(false)
    }
  })
})

describe('recordCastles', () => {
  test('初めて成立した手数を返す', () => {
    const { moves } = play(MOVES)
    const detected = recordCastles(moves)
    expect(detected.map((d) => `${d.template.name}/${d.side}@${d.ply}`)).toEqual([
      '片美濃囲い/white@28',
    ])
  })

  test('同じ囲いは最初の 1 回だけ報告する', () => {
    const { moves } = play(MOVES)
    const keys = recordCastles(moves).map((d) => `${d.template.name}|${d.side}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('指し手が無ければ何も返さない', () => {
    expect(recordCastles([])).toEqual([])
  })
})
