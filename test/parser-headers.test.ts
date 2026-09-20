// テンプレパーサ — ヘッダ系のテスト。parser.test.ts が 629 行あったため分割した 1 本
// (finish: ヘッダだけは parser-finish.test.ts へ、さらに別に切り出してある)。

import { describe, expect, test } from 'bun:test'
import { PieceType } from 'tsshogi'
import { type PlacementCell, type PlacementKind, parseTemplateFile } from '../src/parser.ts'

const EMPTY_ROW = '. . . . . . . . .'

/** 9 行のグリッドを組み立てる。指定が 9 行未満なら空行で埋める。 */
function grid(...rows: string[]): string {
  const filled = [...rows, ...Array(9 - rows.length).fill(EMPTY_ROW)]
  return filled.join('\n')
}

function one(text: string): readonly PlacementCell[] {
  const templates = parseTemplateFile(text)
  expect(templates).toHaveLength(1)
  const first = templates[0]
  if (first === undefined) throw new Error('unreachable')
  return first.placements
}

function firstOfKind(cells: readonly PlacementCell[], kind: PlacementKind): PlacementCell {
  const cell = cells.find((c) => c.kind === kind)
  if (cell === undefined) throw new Error(`no cell of kind ${kind}`)
  return cell
}

describe('headers', () => {
  test('board header becomes pieceAnywhere', () => {
    const text = `=== name: b\nboard: B\n\n${grid('. K . . . . . . .')}`
    const cell = firstOfKind(one(text), 'pieceAnywhere')
    expect(cell.pieceTypes).toEqual([PieceType.BISHOP])
  })

  test('board header with multiple pieces', () => {
    const text = `=== name: b\nboard: B R G\n\n${grid('. K . . . . . . .')}`
    const cells = one(text).filter((c) => c.kind === 'pieceAnywhere')
    expect(cells.map((c) => c.pieceTypes[0])).toEqual([PieceType.BISHOP, PieceType.ROOK, PieceType.GOLD])
  })

  test('hand header default count', () => {
    const text = `=== name: h\nhand: B\n\n${grid('. K . . . . . . .')}`
    const cell = firstOfKind(one(text), 'handPiece')
    expect(cell.pieceTypes).toEqual([PieceType.BISHOP])
    expect(cell.minCount).toBe(1)
  })

  test('hand header with count', () => {
    const text = `=== name: h\nhand: B*2\n\n${grid('. K . . . . . . .')}`
    expect(firstOfKind(one(text), 'handPiece').minCount).toBe(2)
  })

  test('hand header with multiple pieces', () => {
    const text = `=== name: h\nhand: B R\n\n${grid('. K . . . . . . .')}`
    const cells = one(text).filter((c) => c.kind === 'handPiece')
    expect(cells.map((c) => c.pieceTypes[0])).toEqual([PieceType.BISHOP, PieceType.ROOK])
  })

  test('ply eq', () => {
    const text = `=== name: p\nply: 3\n\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect([t?.plyEq, t?.plyMax]).toEqual([3, null])
  })

  test('ply max', () => {
    const text = `=== name: p\nply: max 10\n\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect([t?.plyEq, t?.plyMax]).toEqual([null, 10])
  })

  test('ply eq and max', () => {
    const text = `=== name: p\nply: 3, max 10\n\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect([t?.plyEq, t?.plyMax]).toEqual([3, 10])
  })

  test('ply min', () => {
    const text = `=== name: p\nply: min 5\n\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect([t?.plyEq, t?.plyMin, t?.plyMax]).toEqual([null, 5, null])
  })

  test('ply min and max', () => {
    const text = `=== name: p\nply: min 5, max 10\n\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect([t?.plyEq, t?.plyMin, t?.plyMax]).toEqual([null, 5, 10])
  })

  test('ply min が数値でなければ落ちる', () => {
    const text = `=== name: p\nply: min x\n\n${grid('. K . . . . . . .')}`
    expect(() => parseTemplateFile(text)).toThrow('invalid ply min value')
  })

  test('no ply header means both null', () => {
    const text = `=== name: p\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect([t?.plyEq, t?.plyMin, t?.plyMax]).toEqual([null, null, null])
  })

  test('unmoved header', () => {
    const text = `=== name: u\nunmoved: K 5 9\n\n${grid('. K . . . . . . .')}`
    const cell = firstOfKind(one(text), 'pieceUnmoved')
    expect([cell.file, cell.rank]).toEqual([5, 9])
  })

  test('multiple visited headers', () => {
    const text = `=== name: v\nvisited: R 6 8\nvisited: R 2 8\n\n${grid('. K . . . . . . .')}`
    const cells = one(text).filter((c) => c.kind === 'pieceVisited')
    expect(cells.map((c) => [c.file, c.rank, c.pieceTypes[0]])).toEqual([
      [6, 8, PieceType.ROOK],
      [2, 8, PieceType.ROOK],
    ])
  })

  test('igyoku header sets evaluateAtGameEnd', () => {
    const text = `=== name: i\nigyoku: true\n\n${grid('. K . . . . . . .')}`
    const t = parseTemplateFile(text)[0]
    expect(t?.evaluateAtGameEnd).toBe(true)
    expect(t?.placements.some((c) => c.kind === 'kingIgyoku')).toBe(true)
  })

  test('no_drop header', () => {
    const text = `=== name: n\nno_drop: true\n\n${grid('. K . . . . . . .')}`
    expect(parseTemplateFile(text)[0]?.noDrop).toBe(true)
    // 書かなければ既定は false (これまでどおり打っても成立する)
    expect(parseTemplateFile(`=== name: n\n\n${grid('. K . . . . . . .')}`)[0]?.noDrop).toBe(false)
  })

  test('bishop_exchange header', () => {
    const of = (line: string) =>
      parseTemplateFile(`=== name: n\n${line}\n\n${grid('. K . . . . . . .')}`)[0]?.bishopExchange
    expect(of('bishop_exchange: self')).toBe('self')
    expect(of('bishop_exchange: opponent')).toBe('opponent')
    expect(of('bishop_exchange: any')).toBe('any')
    // 「交換したか」だけを言いたい書き手向けに true も通す (= どちらからでも)
    expect(of('bishop_exchange: true')).toBe('any')
    // 書かなければ問わない
    expect(
      parseTemplateFile(`=== name: n\n\n${grid('. K . . . . . . .')}`)[0]?.bishopExchange,
    ).toBe(null)
    expect(() => of('bishop_exchange: mine')).toThrow(/bishop_exchange must be/)
  })

  test('description header is ignored', () => {
    const text = `=== name: d\ndescription: 人間向けメモ\n\n${grid('. K . . . . . . .')}`
    // 玉のみ
    expect(parseTemplateFile(text)[0]?.placements).toHaveLength(1)
  })
})

// 盤の形を持たない分類の節。グリッドも成立条件も持たないのが正しい形なので、
// 「9 行のグリッドが要る」という他のセクションの規則がそのまま反転する。
describe('category', () => {
  test('グリッドを持たないセクションとして通る', () => {
    const templates = parseTemplateFile('=== name: 振り飛車\ncategory: true\n')
    expect(templates).toHaveLength(1)
    expect(templates[0]?.category).toBe(true)
    expect(templates[0]?.placements).toEqual([])
  })

  test('系統・別名・戦型・説明は一緒に書ける', () => {
    const text =
      '=== name: 三間飛車系\ncategory: true\nparent: 振り飛車\naliases: 三間\nside: furibisha\ndescription: めも\n'
    const first = parseTemplateFile(text)[0]
    expect(first?.parent).toBe('振り飛車')
    expect(first?.aliases).toEqual(['三間'])
    expect(first?.side).toBe('furibisha')
  })

  test('category: false なら普通のセクション (グリッドが要る)', () => {
    const text = `=== name: 普通\ncategory: false\n\n${grid('. K . . . . . . .')}`
    expect(parseTemplateFile(text)[0]?.category).toBe(false)
  })

  test('グリッドを書いたら拒否する', () => {
    const text = `=== name: 分類\ncategory: true\n\n${grid('. K . . . . . . .')}`
    expect(() => parseTemplateFile(text)).toThrow(/takes no grid rows/)
  })

  test('成立条件のヘッダは拒否する', () => {
    for (const header of [
      'ply: 10',
      'no_drop: true',
      'bishop_exchange: any',
      'finish: 3 8',
      'board: R',
      'hand: B',
    ]) {
      expect(() => parseTemplateFile(`=== name: 分類\ncategory: true\n${header}\n`)).toThrow(
        /cannot be used with/,
      )
    }
  })

  test('条件のヘッダを先に書いてあっても拒否する', () => {
    // `category:` は後にも書けるので、順序に依らず咎める
    expect(() => parseTemplateFile('=== name: 分類\nply: 10\ncategory: true\n')).toThrow(
      /"ply" cannot be used with/,
    )
  })

  test('true / false 以外は拒否する', () => {
    expect(() => parseTemplateFile('=== name: 分類\ncategory: yes\n')).toThrow(
      /category must be "true" or "false"/,
    )
  })
})
