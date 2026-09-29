// 定義パーサ — tests/shogi/test_template_parser.py (Python 移植元) の bun:test 版。
//
// 元は parser.test.ts 1 ファイルだったが 629 行あったので、ヘッダ系 (parser-headers.test.ts) と
// finish: ヘッダ (parser-finish.test.ts) を切り出した。ここには基本の解析・升をまたいだ OR (?X)・
// エラー系だけが残る。

import { describe, expect, test } from 'bun:test'
import { PieceType } from 'tsshogi'
import { type PlacementCell, type PlacementKind, parseDefinitionFile } from '../src/parser.ts'

const EMPTY_ROW = '. . . . . . . . .'

/** 9 行のグリッドを組み立てる。指定が 9 行未満なら空行で埋める。 */
function grid(...rows: string[]): string {
  const filled = [...rows, ...Array(9 - rows.length).fill(EMPTY_ROW)]
  return filled.join('\n')
}

function one(text: string): readonly PlacementCell[] {
  const definitions = parseDefinitionFile(text)
  expect(definitions).toHaveLength(1)
  const first = definitions[0]
  if (first === undefined) throw new Error('unreachable')
  return first.placements
}

function firstOfKind(cells: readonly PlacementCell[], kind: PlacementKind): PlacementCell {
  const cell = cells.find((c) => c.kind === kind)
  if (cell === undefined) throw new Error(`no cell of kind ${kind}`)
  return cell
}

describe('parseDefinitionFile', () => {
  test('parses a single basic section', () => {
    const text = `=== name: 金矢倉
parent: 矢倉囲い
aliases: 本矢倉

${grid(
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  EMPTY_ROW,
  '. . S G . . . . .',
  '. K G . . . . . .',
  EMPTY_ROW,
)}
`
    const definitions = parseDefinitionFile(text)
    expect(definitions).toHaveLength(1)
    const t = definitions[0]
    if (t === undefined) throw new Error('unreachable')
    expect(t.name).toBe('金矢倉')
    expect(t.parent).toBe('矢倉囲い')
    expect(t.aliases).toEqual(['本矢倉'])
    expect(t.side).toBeNull()
    // 8八玉 → file 8, rank 8
    const king = t.placements.find((c) => c.pieceTypes[0] === 'king')
    expect(king?.file).toBe(8)
    expect(king?.rank).toBe(8)
    expect(king?.kind).toBe('exact')
  })

  test('parses multiple sections', () => {
    const text = `=== name: A\n${grid('. K . . . . . . .')}\n=== name: B\n${grid('. . K . . . . . .')}\n`
    const definitions = parseDefinitionFile(text)
    expect(definitions.map((t) => t.name)).toEqual(['A', 'B'])
  })

  test('handles anyOf alternation', () => {
    const text = `=== name: alt\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . [GS] . . . .',
      '. K . . . . . . .',
    )}`
    const alt = firstOfKind(one(text), 'anyOf')
    expect(alt.pieceTypes).toEqual([PieceType.GOLD, PieceType.SILVER])
  })

  test('handles promoted pieces', () => {
    const text = `=== name: prom\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . +P . . . .',
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const prom = one(text).find((c) => c.pieceTypes[0] === 'promPawn')
    expect(prom?.file).toBe(5)
    expect(prom?.rank).toBe(6)
  })

  test('handles alternation with promoted piece', () => {
    const text = `=== name: horseAlt\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . [G+R] . . . .',
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const alt = firstOfKind(one(text), 'anyOf')
    expect(alt.pieceTypes).toEqual([PieceType.GOLD, PieceType.DRAGON])
  })

  test('parses side header', () => {
    const text = `=== name: 中飛車\nside: furibisha\n\n${grid('. K . . . . . . .')}`
    expect(parseDefinitionFile(text)[0]?.side).toBe('furibisha')
  })

  test('skips comments and blank lines', () => {
    const text = `# leading comment
=== name: cmt  // trailing comment

# another
${grid('. K . . . . . . .')}
`
    const definitions = parseDefinitionFile(text)
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.name).toBe('cmt')
  })

  test('parses underscore as empty square', () => {
    const text = `=== name: emp\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . _ . . . .',
      EMPTY_ROW,
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const cell = firstOfKind(one(text), 'empty')
    expect([cell.file, cell.rank]).toEqual([5, 5])
    expect(cell.pieceTypes).toEqual([])
  })

  test('parses asterisk as any piece', () => {
    const text = `=== name: any\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . * . . . .',
      EMPTY_ROW,
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const cell = firstOfKind(one(text), 'anyPiece')
    expect([cell.file, cell.rank]).toEqual([5, 5])
  })

  test('parses negated alternation', () => {
    const text = `=== name: neg\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . [!GS] . . . .',
      EMPTY_ROW,
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const cell = firstOfKind(one(text), 'notOf')
    expect(cell.pieceTypes).toEqual([PieceType.GOLD, PieceType.SILVER])
  })

  test('parses negated alternation with promoted', () => {
    const text = `=== name: neg2\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. . . . [!+P+L] . . . .',
      EMPTY_ROW,
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const cell = firstOfKind(one(text), 'notOf')
    expect(cell.pieceTypes).toEqual([PieceType.PROM_PAWN, PieceType.PROM_LANCE])
  })

  test('lowercase token is opponent piece', () => {
    const text = `=== name: opp\n${grid(
      '. . . . k . . . .',
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. K . . . . . . .',
    )}`
    const cell = firstOfKind(one(text), 'opponent')
    expect(cell.pieceTypes).toEqual([PieceType.KING])
    expect([cell.file, cell.rank]).toEqual([5, 1])
  })
})

// 升をまたぐ唯一の要件。同じ駒指定の `?` セルが 1 件にまとまるので、
// 「1 セル = 1 要件」という他のトークンの前提がここだけ崩れる。
describe('升をまたいだ OR (?X)', () => {
  test('同じ駒指定の升が 1 件にまとまる', () => {
    // 相手の飛車が 5〜1 筋のどこか = 相手が振り飛車である
    const cells = one(
      `=== name: 対振り\n\n${grid(
        EMPTY_ROW,
        '. . . . ?r ?r ?r ?r ?r',
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
        EMPTY_ROW,
        '. . B . . . . . .',
      )}`,
    )
    // OR 1 件 + 7七角
    expect(cells).toHaveLength(2)
    const or = firstOfKind(cells, 'opponentInSquares')
    expect(or.pieceTypes).toEqual([PieceType.ROOK])
    expect(or.squares).toEqual([
      { file: 5, rank: 2 },
      { file: 4, rank: 2 },
      { file: 3, rank: 2 },
      { file: 2, rank: 2 },
      { file: 1, rank: 2 },
    ])
  })

  test('駒指定が違えば別の件になる。行をまたいでも 1 件にまとまる', () => {
    const cells = one(`=== name: 二群\n\n${grid('?R . . . . . . . ?b', '?R . . . . . . . .')}`)
    expect(cells).toHaveLength(2)
    const own = firstOfKind(cells, 'pieceInSquares')
    expect(own.pieceTypes).toEqual([PieceType.ROOK])
    expect(own.squares).toEqual([
      { file: 9, rank: 1 },
      { file: 9, rank: 2 },
    ])
    expect(firstOfKind(cells, 'opponentInSquares').squares).toEqual([{ file: 1, rank: 1 }])
  })

  test('複数駒の指定は並び順に依らず同じ群になる', () => {
    const cells = one(`=== name: 群\n\n${grid('?[RB] . . . . . . . ?[BR]')}`)
    expect(cells).toHaveLength(1)
    expect(cells[0]?.squares).toHaveLength(2)
  })

  test('駒を指定しない OR は拒否する', () => {
    // どれも盤のほぼ全局面で真になるので、書けると「効かない定義」ができる
    for (const token of ['?', '?_', '?*', '?[!GS]']) {
      expect(() =>
        parseDefinitionFile(`=== name: bad\n\n${grid(`${token} . . . . . . . .`)}`),
      ).toThrow(/\?/)
    }
  })
})

describe('errors', () => {
  test('throws on missing grid rows', () => {
    const text = `=== name: short\n${[EMPTY_ROW, '. K . . . . . . .', EMPTY_ROW].join('\n')}`
    expect(() => parseDefinitionFile(text)).toThrow()
  })

  test('throws on wrong cell count', () => {
    const rows = [...Array(7).fill(EMPTY_ROW), '. K . . . . . . .', '. . . .']
    expect(() => parseDefinitionFile(`=== name: bad\n${rows.join('\n')}`)).toThrow()
  })

  test('throws on unknown piece token', () => {
    const text = `=== name: bad\n${grid(
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      '. X . . . . . . .',
    )}`
    expect(() => parseDefinitionFile(text)).toThrow()
  })

  test('throws on unknown side value', () => {
    const text = `=== name: bad\nside: nonsense\n\n${grid('. K . . . . . . .')}`
    expect(() => parseDefinitionFile(text)).toThrow()
  })

  test('throws on unknown header', () => {
    const text = `=== name: bad\nnonsense: 1\n\n${grid('. K . . . . . . .')}`
    expect(() => parseDefinitionFile(text)).toThrow()
  })

  test('throws on content outside section', () => {
    expect(() => parseDefinitionFile('. K . . . . . . .\n')).toThrow()
  })

  test('error carries the offending line number', () => {
    // 4 行目 (1-indexed) に不正トークン
    const text = `=== name: bad\n${grid(EMPTY_ROW, EMPTY_ROW, '. X . . . . . . .')}`
    expect(() => parseDefinitionFile(text)).toThrow(/line 4/)
  })
})
