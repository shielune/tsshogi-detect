// テンプレパーサ — finish: ヘッダ (成立を認める最終手) のテスト。
// parser.test.ts が 629 行あったため、この節だけ独立させた。

import { describe, expect, test } from 'bun:test'
import { PieceType } from 'tsshogi'
import { parseTemplateFile } from '../src/parser.ts'

const EMPTY_ROW = '. . . . . . . . .'

/** 9 行のグリッドを組み立てる。指定が 9 行未満なら空行で埋める。 */
function grid(...rows: string[]): string {
  const filled = [...rows, ...Array(9 - rows.length).fill(EMPTY_ROW)]
  return filled.join('\n')
}

describe('headers', () => {
  test('finish header', () => {
    const text = `=== name: f\nfinish: 3 8\n\n${grid('. K . . . . . . .')}`
    // 移動元を書かなければ着地升だけの指定 (from は null)。取った駒も書かなければ null (問わない)
    expect(parseTemplateFile(text)[0]?.finishMoves).toEqual([
      { from: null, to: { file: 3, rank: 8 }, capture: null, promote: false, drop: false },
    ])
    // 複数書けばそのどれかの手 (最終手は 1 つなので OR)
    const many = `=== name: f\nfinish: 3 8, 2 8\n\n${grid('. K . . . . . . .')}`
    expect(parseTemplateFile(many)[0]?.finishMoves).toEqual([
      { from: null, to: { file: 3, rank: 8 }, capture: null, promote: false, drop: false },
      { from: null, to: { file: 2, rank: 8 }, capture: null, promote: false, drop: false },
    ])
    // 書かなければ制限なし
    expect(
      parseTemplateFile(`=== name: f\n\n${grid('. K . . . . . . .')}`)[0]?.finishMoves,
    ).toEqual([])
    expect(() =>
      parseTemplateFile(`=== name: f\nfinish: 3\n\n${grid('. K . . . . . . .')}`),
    ).toThrow()
  })

  test('finish header with origin square', () => {
    // `>` の左が移動元。7七から7六へ指した手でだけ成立させる
    const text = `=== name: f\nfinish: 7 7 > 7 6\n\n${grid('. K . . . . . . .')}`
    expect(parseTemplateFile(text)[0]?.finishMoves).toEqual([
      {
        from: { file: 7, rank: 7 },
        to: { file: 7, rank: 6 },
        capture: null,
        promote: false,
        drop: false,
      },
    ])
    // 移動元あり・なしは同じ行に混ぜて書ける
    const mixed = `=== name: f\nfinish: 7 7 > 7 6, 3 8\n\n${grid('. K . . . . . . .')}`
    expect(parseTemplateFile(mixed)[0]?.finishMoves).toEqual([
      {
        from: { file: 7, rank: 7 },
        to: { file: 7, rank: 6 },
        capture: null,
        promote: false,
        drop: false,
      },
      { from: null, to: { file: 3, rank: 8 }, capture: null, promote: false, drop: false },
    ])
    // 片側が升になっていない / `>` が 2 つ以上 / 範囲外はどれも拒否する
    for (const value of ['7 7 >', '> 7 6', '7 7 > 7 6 > 7 5', '7 7 > 0 6']) {
      expect(() =>
        parseTemplateFile(`=== name: f\nfinish: ${value}\n\n${grid('. K . . . . . . .')}`),
      ).toThrow()
    }
  })

  test('finish header with captured piece', () => {
    const parse = (value: string) =>
      parseTemplateFile(`=== name: f\nfinish: ${value}\n\n${grid('. K . . . . . . .')}`)[0]
        ?.finishMoves
    // `x` の右が取った駒。駒種はその時の姿で書く (と金は `+P`)
    expect(parse('2 4 > 2 3 x P')).toEqual([
      {
        from: { file: 2, rank: 4 },
        to: { file: 2, rank: 3 },
        capture: { kind: 'pieces', pieces: [PieceType.PAWN], negated: false },
        promote: false,
        drop: false,
      },
    ])
    expect(parse('2 8 x +p')?.[0]?.capture).toEqual({
      kind: 'pieces',
      pieces: [PieceType.PROM_PAWN],
      negated: false,
    })
    // `*` は何か取る手、`_` は取らない手
    expect(parse('2 8 x *')?.[0]?.capture).toEqual({ kind: 'any' })
    expect(parse('2 8 x _')?.[0]?.capture).toEqual({ kind: 'none' })
    // 升と同じ書き方で複数駒と否定も書ける ([BR] = 角か飛 / [!BR] = 角飛以外の何か)
    expect(parse('2 8 x [BR]')?.[0]?.capture).toEqual({
      kind: 'pieces',
      pieces: [PieceType.BISHOP, PieceType.ROOK],
      negated: false,
    })
    expect(parse('2 8 x [!BR]')?.[0]?.capture).toEqual({
      kind: 'pieces',
      pieces: [PieceType.BISHOP, PieceType.ROOK],
      negated: true,
    })
    // 駒になっていない / 空の並び / `x` が 2 つ以上はどれも拒否する
    for (const value of ['2 8 x', '2 8 x Z', '2 8 x [', '2 8 x []', '2 8 x [!]', '2 8 x P x P']) {
      expect(() => parse(value)).toThrow()
    }
  })

  test('finish header with promotion marker', () => {
    const parse = (value: string) =>
      parseTemplateFile(`=== name: f\nfinish: ${value}\n\n${grid('. K . . . . . . .')}`)[0]
        ?.finishMoves
    // 着地升の右の `+` は「成った手だけ」。盤は指した後の姿しか言えないので、
    // 角が成った手か馬が動いた手かを言い分けられるのはこの指定だけ
    expect(parse('8 8 > 3 3 +')).toEqual([
      {
        from: { file: 8, rank: 8 },
        to: { file: 3, rank: 3 },
        capture: null,
        promote: true,
        drop: false,
      },
    ])
    // 移動元を書かない項目にも付く。取った駒とも併せて書ける (`+` は `x` より前)
    expect(parse('3 3 +')?.[0]?.promote).toBe(true)
    expect(parse('8 8 > 3 3 + x B')?.[0]).toEqual({
      from: { file: 8, rank: 8 },
      to: { file: 3, rank: 3 },
      capture: { kind: 'pieces', pieces: [PieceType.BISHOP], negated: false },
      promote: true,
      drop: false,
    })
    // 書かなければ成/不成は問わない
    expect(parse('8 8 > 3 3')?.[0]?.promote).toBe(false)
  })

  test('finish header with drop marker', () => {
    const parse = (value: string) =>
      parseTemplateFile(`=== name: f\nfinish: ${value}\n\n${grid('. K . . . . . . .')}`)[0]
        ?.finishMoves
    // 着地升の右の `打` は「打った手だけ」。盤上を動かして同じ升へ来た手は外れる
    expect(parse('3 3 打')).toEqual([
      { from: null, to: { file: 3, rank: 3 }, capture: null, promote: false, drop: true },
    ])
    // 書かなければ打ちも盤上の手も当たる
    expect(parse('3 3')?.[0]?.drop).toBe(false)
    // 打ちは移動元も成りも取った駒も持たないので、どれとも混ぜて書けない
    for (const value of ['8 8 > 3 3 打', '3 3 + 打', '3 3 打 x P', '3 3 打 x _']) {
      expect(() =>
        parseTemplateFile(`=== name: f\nfinish: ${value}\n\n${grid('. K . . . . . . .')}`),
      ).toThrow()
    }
  })
})
