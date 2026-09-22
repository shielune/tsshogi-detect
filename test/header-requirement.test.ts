// 盤外の要件の付け外し。ヘッダ以外の行が 1 文字も動かないことまで見る。

import { describe, expect, test } from 'bun:test'
import { PieceType } from 'tsshogi'
import {
  addHeaderRequirement,
  isHeaderRequirement,
  removeHeaderRequirement,
  updateHeaderRequirement,
} from '../src/header-requirement.ts'
import { type PlacementCell, type PlacementKind, parseDefinitionFile } from '../src/parser.ts'

const GRID = Array.from({ length: 9 }, () => '. . . . . . . . .').join('\n')

/** ヘッダを並べた定義 1 件を組む (0 件なら空行 1 本だけ挟む)。 */
const dsl = (headers: readonly string[]) =>
  `=== name: 角換わり\n${headers.map((line) => `${line}\n`).join('')}\n${GRID}\n`

/** 組んだ定義の盤外の要件を、パーサが読んだ形で並べる。 */
const extras = (text: string): readonly PlacementCell[] =>
  (parseDefinitionFile(text)[0]?.placements ?? []).filter(isHeaderRequirement)

/** 要件 1 件を「何番目の盤外の要件か」で引く。 */
const pick = (text: string, index = 0): PlacementCell => {
  const cell = extras(text)[index]
  if (cell === undefined) throw new Error('unreachable')
  return cell
}

/** 手で組む要件。パーサの cell() と同じ既定値。 */
const cell = (kind: PlacementKind, partial: Partial<PlacementCell> = {}): PlacementCell => ({
  kind,
  file: 0,
  rank: 0,
  pieceTypes: [],
  minCount: 1,
  squares: [],
  ...partial,
})

describe('isHeaderRequirement', () => {
  test('盤の升は除き、ヘッダ由来の要件だけを拾う', () => {
    const text = dsl(['visited: B 8 8', 'hand: P'])
    const placements = parseDefinitionFile(text)[0]?.placements ?? []
    // 盤は全部 `.` (指定なし) なので、残るのはヘッダの 2 件だけ
    expect(placements.filter(isHeaderRequirement)).toHaveLength(2)
  })
})

describe('removeHeaderRequirement', () => {
  test('行 1 本の要件は行ごと消える', () => {
    const text = dsl(['ply: 20', 'visited: B 8 8'])
    expect(removeHeaderRequirement(text, pick(text))).toBe(dsl(['ply: 20']))
  })

  test('同じ鍵が何行もあれば、狙った行だけ消える', () => {
    const text = dsl(['visited: R 6 8', 'visited: B 8 8'])
    expect(removeHeaderRequirement(text, pick(text, 1))).toBe(dsl(['visited: R 6 8']))
  })

  test('1 行に並んだ board: はトークンだけ落ちる', () => {
    const text = dsl(['board: B R G'])
    expect(removeHeaderRequirement(text, pick(text, 1))).toBe(dsl(['board: B G']))
  })

  test('最後の 1 つを落とすと行ごと消える', () => {
    const text = dsl(['board: B'])
    expect(removeHeaderRequirement(text, pick(text))).toBe(dsl([]))
  })

  test('持駒は枚数まで見て同じものを落とす', () => {
    const text = dsl(['hand: P*2 P'])
    // 2 枚の歩と 1 枚の歩は別の要件。1 枚のほうを落とす
    expect(removeHeaderRequirement(text, pick(text, 1))).toBe(dsl(['hand: P*2']))
  })

  test('居玉も消せる', () => {
    const text = dsl(['igyoku: true'])
    expect(removeHeaderRequirement(text, pick(text))).toBe(dsl([]))
  })

  test('書いていない要件は消せない', () => {
    expect(
      removeHeaderRequirement(
        dsl(['visited: B 8 8']),
        cell('handPiece', { pieceTypes: [PieceType.PAWN] }),
      ),
    ).toBeNull()
  })

  test('行末コメントの付いた行でも、残る駒とコメントはそのまま', () => {
    const text = dsl(['board: B R  # 角と飛車'])
    expect(removeHeaderRequirement(text, pick(text))).toBe(dsl(['board: R  # 角と飛車']))
  })
})

describe('updateHeaderRequirement', () => {
  test('通った升と駒を書き換える', () => {
    const text = dsl(['visited: B 8 8'])
    const next = updateHeaderRequirement(text, pick(text), {
      ...pick(text),
      file: 3,
      rank: 3,
      pieceTypes: [PieceType.HORSE],
    })
    expect(next).toBe(dsl(['visited: +B 3 3']))
  })

  test('unmoved: は駒種トークンを書き換えずに残す', () => {
    // パーサは unmoved: の駒種を捨てる (升だけで引く) ので、要件からは復元できない
    const text = dsl(['unmoved: S 3 9'])
    const next = updateHeaderRequirement(text, pick(text), { ...pick(text), file: 7, rank: 9 })
    expect(next).toBe(dsl(['unmoved: S 7 9']))
  })

  test('1 行に並んだ hand: はそのトークンだけ書き換わる', () => {
    const text = dsl(['hand: B P*2'])
    const next = updateHeaderRequirement(text, pick(text, 1), {
      ...pick(text, 1),
      minCount: 3,
    })
    expect(next).toBe(dsl(['hand: B P*3']))
  })

  test('種類は変えられない', () => {
    const text = dsl(['visited: B 8 8'])
    expect(
      updateHeaderRequirement(
        text,
        pick(text),
        cell('handPiece', { pieceTypes: [PieceType.BISHOP] }),
      ),
    ).toBeNull()
  })

  test('書き換えた本文はパースできる', () => {
    const text = dsl(['visited: B 8 8'])
    const next = updateHeaderRequirement(text, pick(text), {
      ...pick(text),
      pieceTypes: [PieceType.ROOK],
    })
    expect(extras(next ?? '')[0]?.pieceTypes).toEqual([PieceType.ROOK])
  })
})

describe('addHeaderRequirement', () => {
  test('行 1 本の要件は同じ鍵の最後の次に足す', () => {
    const text = dsl(['visited: R 6 8', 'ply: 20'])
    expect(
      addHeaderRequirement(
        text,
        cell('pieceVisited', { file: 8, rank: 8, pieceTypes: [PieceType.BISHOP] }),
      ),
    ).toBe(dsl(['visited: R 6 8', 'visited: B 8 8', 'ply: 20']))
  })

  test('鍵の行が無ければ === name: の直後に足す', () => {
    expect(addHeaderRequirement(dsl(['ply: 20']), cell('kingIgyoku'))).toBe(
      dsl(['igyoku: true', 'ply: 20']),
    )
  })

  test('board:/hand: は既にある行に足す (行を増やさない)', () => {
    expect(
      addHeaderRequirement(
        dsl(['hand: B']),
        cell('handPiece', { pieceTypes: [PieceType.PAWN], minCount: 2 }),
      ),
    ).toBe(dsl(['hand: B P*2']))
  })

  test('既に書いてある要件は足さない', () => {
    const text = dsl(['visited: B 8 8'])
    expect(addHeaderRequirement(text, pick(text))).toBe(text)
  })

  test('足した本文はパースできる', () => {
    const next = addHeaderRequirement(
      dsl([]),
      cell('pieceUnmoved', { file: 8, rank: 2, pieceTypes: [PieceType.ROOK] }),
    )
    expect(next).toBe(dsl(['unmoved: R 8 2']))
    expect(extras(next ?? '')[0]?.kind).toBe('pieceUnmoved')
  })
})
