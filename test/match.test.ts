// 局面と定義の照合。ここでは要件 1 つ 1 つではなく、定義に付いた縛り
// (相手駒の除外・角交換) が matchesDefinition を通してどう効くかを見る。

import { describe, expect, test } from 'bun:test'
import { Color, PieceType, Record as ShogiRecord } from 'tsshogi'
import type { BishopExchange, FormationDefinition } from '../src/definition.ts'
import { matchesDefinition } from '../src/match.ts'
import { MoveHistory } from '../src/move-history.ts'
import { NotOfPieces } from '../src/requirements.ts'

function play(usiMoves: string): { record: ShogiRecord; history: MoveHistory } {
  const record = new ShogiRecord()
  const history = new MoveHistory()
  history.initFromPosition(record.position)
  for (const [index, usi] of usiMoves.split(' ').filter((m) => m !== '').entries()) {
    const move = record.position.createMoveByUSI(usi)
    if (!move) throw new Error(`不正な指し手: ${usi}`)
    history.recordMove(move, index + 1)
    record.append(move)
  }
  return { record, history }
}

const definition = (partial: Partial<FormationDefinition>): FormationDefinition => ({
  name: 'テスト',
  placements: [],
  ...partial,
})

describe('相手駒の除外 [!r]', () => {
  const { record } = play('')

  test('相手の飛車が居る升では成立しない', () => {
    // 平手の 8 二には後手の飛車が居る。後手から見ても先手の飛車が居る升 (2 八) に回る
    const rook = definition({ placements: [new NotOfPieces(8, 2, [PieceType.ROOK], Color.WHITE)] })
    expect(matchesDefinition(record.position, rook, Color.BLACK)).toBe(false)
    expect(matchesDefinition(record.position, rook, Color.WHITE)).toBe(false)
  })

  test('相手の別の駒・自分の同じ駒・空升は満たす', () => {
    const at = (file: number, rank: number) =>
      definition({ placements: [new NotOfPieces(file, rank, [PieceType.ROOK], Color.WHITE)] })
    // 2 二は後手の角、2 八は自分の飛車、5 五は空升
    expect(matchesDefinition(record.position, at(2, 2), Color.BLACK)).toBe(true)
    expect(matchesDefinition(record.position, at(2, 8), Color.BLACK)).toBe(true)
    expect(matchesDefinition(record.position, at(5, 5), Color.BLACK)).toBe(true)
  })

  test('色を省けば今までどおり自駒の除外', () => {
    const own = definition({ placements: [new NotOfPieces(2, 8, [PieceType.ROOK])] })
    expect(matchesDefinition(record.position, own, Color.BLACK)).toBe(false)
  })
})

describe('bishop_exchange', () => {
  // ▲7六歩 △3四歩 ▲2二角成 △同銀 で、先手から仕掛けた角交換が済む
  const exchanged = play('7g7f 3c3d 8h2b+ 3a2b')
  const opened = play('7g7f 3c3d')

  const of = (bishopExchange: BishopExchange) => definition({ bishopExchange })

  test('never は交換が済んでいない局面だけに当たる', () => {
    expect(matchesDefinition(opened.record.position, of('never'), Color.BLACK, opened.history)).toBe(
      true,
    )
    for (const side of [Color.BLACK, Color.WHITE]) {
      expect(
        matchesDefinition(exchanged.record.position, of('never'), side, exchanged.history),
      ).toBe(false)
    }
  })

  test('never でも履歴が無ければ成立させない', () => {
    expect(matchesDefinition(opened.record.position, of('never'), Color.BLACK)).toBe(false)
  })

  test('仕掛けた側は判定する陣営から見て言う', () => {
    const { record, history } = exchanged
    expect(matchesDefinition(record.position, of('self'), Color.BLACK, history)).toBe(true)
    expect(matchesDefinition(record.position, of('self'), Color.WHITE, history)).toBe(false)
    expect(matchesDefinition(record.position, of('opponent'), Color.WHITE, history)).toBe(true)
    expect(matchesDefinition(record.position, of('any'), Color.WHITE, history)).toBe(true)
    expect(matchesDefinition(opened.record.position, of('any'), Color.BLACK, opened.history)).toBe(
      false,
    )
  })
})
