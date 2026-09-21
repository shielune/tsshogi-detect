// 検出結果の並び順。成立の可否は変えず、返す配列の順番だけを変える。
// 同じ手で成立するテンプレを並べ、決着が付く段を 1 つずつ確かめる。

import { describe, expect, test } from 'bun:test'
import { PieceType, type Move, Record as ShogiRecord } from 'tsshogi'
import { detectTemplates } from '../src/match.ts'
import { priorityOf } from '../src/order.ts'
import { PiecePlacement } from '../src/requirements.ts'
import { recordTemplates } from '../src/scan.ts'
import type { FormationTemplate } from '../src/template.ts'

/** 玉が定位置に居れば成立するテンプレ。初形で両陣営とも当たる。 */
const king = (name: string, extra?: Partial<FormationTemplate>): FormationTemplate => ({
  name,
  placements: [new PiecePlacement(5, 9, PieceType.KING)],
  ...extra,
})

/** 玉に 7 七の歩を足した、1 つ狭いテンプレ。これも初形で当たる。 */
const kingAndPawn = (name: string, extra?: Partial<FormationTemplate>): FormationTemplate => ({
  name,
  placements: [new PiecePlacement(5, 9, PieceType.KING), new PiecePlacement(7, 7, PieceType.PAWN)],
  ...extra,
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
    expect(priorityOf(king('一'))).toBe(0)
    expect(priorityOf(king('二', { priority: 10 }))).toBe(10)
    expect(priorityOf(king('三', { priority: -10 }))).toBe(-10)
  })
})

describe('detectTemplates', () => {
  const position = new ShogiRecord().position

  test('優先度が大きいほど前に出る', () => {
    const detected = detectTemplates([king('一'), king('二', { priority: 10 })], position)
    expect(names(detected)).toEqual(['二/black', '二/white', '一/black', '一/white'])
  })

  test('負の数を書けば後ろへ回る', () => {
    const detected = detectTemplates([king('一', { priority: -10 }), king('二')], position)
    expect(names(detected)).toEqual(['二/black', '二/white', '一/black', '一/white'])
  })

  test('優先度が同じならネストの深い方が前', () => {
    // 子は親を狭めた形なので、両方成立したら子を代表として扱いたい。
    const templates = [king('親'), king('子', { parent: '親' }), king('孫', { parent: '子' })]
    expect(names(detectTemplates(templates, position))).toEqual([
      '孫/black',
      '孫/white',
      '子/black',
      '子/white',
      '親/black',
      '親/white',
    ])
  })

  test('深さが同じなら制約の厳しい方が前', () => {
    // 系統の付いていないテンプレどうしは、要件の数で狭さを測る。
    const templates = [king('緩い'), kingAndPawn('狭い')]
    expect(names(detectTemplates(templates, position))).toEqual([
      '狭い/black',
      '狭い/white',
      '緩い/black',
      '緩い/white',
    ])
  })

  test('どれも同じなら名前の文字コード順', () => {
    // 一 (U+4E00) は 二 (U+4E8C) より前。渡した順ではなく名前で決まる。
    expect(names(detectTemplates([king('二'), king('一')], position))).toEqual([
      '一/black',
      '一/white',
      '二/black',
      '二/white',
    ])
  })

  test('件数は変わらない', () => {
    const templates = [king('一'), king('二', { priority: 10 }), king('三', { priority: -10 })]
    expect(detectTemplates(templates, position)).toHaveLength(6)
  })
})

describe('recordTemplates', () => {
  const moves = play('7g7f 3c3d 6g6f')

  test('盤の外の条件も厳しさに数える', () => {
    // 手数の制約は局面 1 枚では検証できないので、走査の側で見る。
    // 升の要件は同じ数なので、plyMax を書いた二の方が 1 つ狭い。
    const templates = [king('一'), king('二', { plyMax: 40 })]
    expect(namesAt(recordTemplates(templates, moves))).toEqual([
      '二/black@1',
      '二/white@1',
      '一/black@1',
      '一/white@1',
    ])
  })

  test('並べ替えは同じ手数の固まりの中だけ', () => {
    const templates = [king('一'), king('二', { priority: 10 }), pawn66('三', 100)]
    // 三の 100 は 1 手目の組より前には出ない。手数が主たる順序で、
    // 優先度から名前までは、その中の決着の付け方にとどまる。
    expect(namesAt(recordTemplates(templates, moves))).toEqual([
      '二/black@1',
      '二/white@1',
      '一/black@1',
      '一/white@1',
      '三/black@3',
    ])
  })
})
