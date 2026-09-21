// 優先度 (`priority:`) は成立の可否を変えず、返す配列の順番だけを変える。
// 同じ条件のテンプレを名前と優先度だけ変えて並べ、入れ替わりを見る。

import { describe, expect, test } from 'bun:test'
import { PieceType, type Move, Record as ShogiRecord } from 'tsshogi'
import { detectTemplates } from '../src/match.ts'
import { priorityOf } from '../src/priority.ts'
import { PiecePlacement } from '../src/requirements.ts'
import { recordTemplates } from '../src/scan.ts'
import type { FormationTemplate } from '../src/template.ts'

/** 玉が定位置に居れば成立するテンプレ。違うのは名前と優先度だけ。 */
const king = (name: string, priority?: number): FormationTemplate => ({
  name,
  ...(priority === undefined ? {} : { priority }),
  placements: [new PiecePlacement(5, 9, PieceType.KING)],
})

/** 6 六の歩。3 手目で初めて成立する、後から立つ側のテンプレ。 */
const pawn66 = (name: string, priority: number): FormationTemplate => ({
  name,
  priority,
  placements: [new PiecePlacement(6, 6, PieceType.PAWN)],
})

function play(usiMoves: string): Move[] {
  const record = new ShogiRecord()
  const moves: Move[] = []
  for (const usi of usiMoves.split(' ')) {
    const move = record.position.createMoveByUSI(usi)
    if (!move) throw new Error(`不正な指し手: ${usi}`)
    moves.push(move)
    record.append(move)
  }
  return moves
}

const names = (list: readonly { template: { name: string }; side: string }[]): string[] =>
  list.map((entry) => `${entry.template.name}/${entry.side}`)

const namesAt = (
  list: readonly { template: { name: string }; side: string; ply: number }[],
): string[] => list.map((entry) => `${entry.template.name}/${entry.side}@${entry.ply}`)

describe('priorityOf', () => {
  test('書いていなければ 0', () => {
    expect(priorityOf(king('甲'))).toBe(0)
    expect(priorityOf(king('乙', 10))).toBe(10)
    expect(priorityOf(king('丙', -10))).toBe(-10)
  })
})

describe('detectTemplates', () => {
  const position = new ShogiRecord().position

  test('優先度が無ければ渡した順のまま', () => {
    const detected = detectTemplates([king('甲'), king('乙')], position)
    expect(names(detected)).toEqual(['甲/black', '甲/white', '乙/black', '乙/white'])
  })

  test('大きいほど前に出る', () => {
    const detected = detectTemplates([king('甲'), king('乙', 10)], position)
    expect(names(detected)).toEqual(['乙/black', '乙/white', '甲/black', '甲/white'])
  })

  test('負の数を書けば後ろへ回る', () => {
    const detected = detectTemplates([king('甲', -10), king('乙')], position)
    expect(names(detected)).toEqual(['乙/black', '乙/white', '甲/black', '甲/white'])
  })

  test('件数は変わらない', () => {
    const templates = [king('甲'), king('乙', 10), king('丙', -10)]
    expect(detectTemplates(templates, position)).toHaveLength(6)
  })
})

describe('recordTemplates', () => {
  const moves = play('7g7f 3c3d 6g6f')

  test('同じ手数の中だけが入れ替わる', () => {
    const templates = [king('甲'), king('乙', 10), pawn66('丙', 100)]
    // 丙の 100 は 1 手目の組より前には出ない。手数が主たる順序で、
    // 優先度はその中の決着の付け方にとどまる。
    expect(namesAt(recordTemplates(templates, moves))).toEqual([
      '乙/black@1',
      '乙/white@1',
      '甲/black@1',
      '甲/white@1',
      '丙/black@3',
    ])
  })

  test('優先度を書かなければ今までどおりの順', () => {
    const templates = [king('甲'), king('乙'), pawn66('丙', 0)]
    expect(namesAt(recordTemplates(templates, moves))).toEqual([
      '甲/black@1',
      '甲/white@1',
      '乙/black@1',
      '乙/white@1',
      '丙/black@3',
    ])
  })
})
