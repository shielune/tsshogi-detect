import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PieceType } from 'tsshogi'
import {
  cellFromToken,
  flipCellSide,
  normalizeCell,
  PIECE_ORDER,
  PIECE_SFEN,
  type DefinitionCell,
  tokenFromCell,
} from '../src/cell-token.ts'
import { extractGrid } from '../src/grid-text.ts'
import { parseDefinitionFile } from '../src/parser.ts'

const ASSETS = join(import.meta.dir, '../data')
const FILES = ['castles.txt', 'strategies.txt'] as const

describe('cellFromToken', () => {
  test('特殊トークン', () => {
    expect(cellFromToken('.')).toEqual({ kind: 'unspecified' })
    expect(cellFromToken('_')).toEqual({ kind: 'empty' })
    expect(cellFromToken('*')).toEqual({ kind: 'anyPiece' })
  })

  test('自駒 (大文字)', () => {
    expect(cellFromToken('G')).toEqual({
      kind: 'pieces',
      pieces: [PieceType.GOLD],
      side: 'own',
      negated: false,
    })
    expect(cellFromToken('+R')).toEqual({
      kind: 'pieces',
      pieces: [PieceType.DRAGON],
      side: 'own',
      negated: false,
    })
  })

  test('相手駒 (小文字)。成駒の小文字は末尾文字で判定される', () => {
    expect(cellFromToken('g')).toEqual({
      kind: 'pieces',
      pieces: [PieceType.GOLD],
      side: 'opponent',
      negated: false,
    })
    // strategies.txt に実在する唯一の相手成駒。
    expect(cellFromToken('+b')).toEqual({
      kind: 'pieces',
      pieces: [PieceType.HORSE],
      side: 'opponent',
      negated: false,
    })
  })

  test('anyOf / notOf は暗黙に自駒文脈', () => {
    expect(cellFromToken('[GS]')).toEqual({
      kind: 'pieces',
      pieces: [PieceType.GOLD, PieceType.SILVER],
      side: 'own',
      negated: false,
    })
    expect(cellFromToken('[!GS]')).toEqual({
      kind: 'pieces',
      pieces: [PieceType.GOLD, PieceType.SILVER],
      side: 'own',
      negated: true,
    })
  })

  test('升をまたいだ OR (?X) は別の kind になる', () => {
    expect(cellFromToken('?r')).toEqual({
      kind: 'orPieces',
      pieces: [PieceType.ROOK],
      side: 'opponent',
    })
    expect(cellFromToken('?[RB]')).toEqual({
      kind: 'orPieces',
      pieces: [PieceType.ROOK, PieceType.BISHOP],
      side: 'own',
    })
  })

  test.each(['', '[]', '[!]', '+', 'X', '[G', 'GS', '[GX]', '..', '?', '?_', '?*', '?[!GS]'])(
    '解析不能なら null: %p',
    (token) => {
      expect(cellFromToken(token)).toBeNull()
    },
  )
})

describe('tokenFromCell', () => {
  test.each([
    '.',
    '_',
    '*',
    'P',
    'L',
    'N',
    'S',
    'G',
    'B',
    'R',
    'K',
    '+P',
    '+L',
    '+N',
    '+S',
    '+B',
    '+R',
    'p',
    'l',
    'n',
    's',
    'g',
    'b',
    'r',
    'k',
    '+b',
    '[GS]',
    '[!GS]',
    '[!R]',
    '[SGN]',
    '?R',
    '?r',
    '?[RB]',
  ])('往復して同じトークンに戻る: %p', (token) => {
    const cell = cellFromToken(token)
    expect(cell).not.toBeNull()
    if (cell === null) return
    expect(tokenFromCell(cell)).toBe(token)
  })

  test('既知の非対称: [G] は G に縮退する (判定は同値)', () => {
    const cell = cellFromToken('[G]')
    expect(cell).not.toBeNull()
    if (cell === null) return
    expect(tokenFromCell(cell)).toBe('G')
  })

  test('駒順は並べ替えない', () => {
    expect(
      tokenFromCell({
        kind: 'pieces',
        pieces: [PieceType.SILVER, PieceType.GOLD],
        side: 'own',
        negated: false,
      }),
    ).toBe('[SG]')
    expect(
      tokenFromCell({
        kind: 'pieces',
        pieces: [PieceType.GOLD, PieceType.SILVER],
        side: 'own',
        negated: false,
      }),
    ).toBe('[GS]')
  })
})

describe('normalizeCell', () => {
  test('相手駒は複数指定できないので先頭だけ残す', () => {
    expect(
      normalizeCell({
        kind: 'pieces',
        pieces: [PieceType.GOLD, PieceType.SILVER],
        side: 'opponent',
        negated: false,
      }),
    ).toEqual({ kind: 'pieces', pieces: [PieceType.GOLD], side: 'opponent', negated: false })
  })

  test('相手駒の否定は書けないので否定を落とす', () => {
    expect(
      normalizeCell({
        kind: 'pieces',
        pieces: [PieceType.ROOK],
        side: 'opponent',
        negated: true,
      }),
    ).toEqual({ kind: 'pieces', pieces: [PieceType.ROOK], side: 'opponent', negated: false })
  })

  test('駒を 1 つも選んでいなければ無指定に落ちる', () => {
    expect(normalizeCell({ kind: 'pieces', pieces: [], side: 'own', negated: false })).toEqual({
      kind: 'unspecified',
    })
  })

  test('特殊トークンはそのまま', () => {
    expect(normalizeCell({ kind: 'empty' })).toEqual({ kind: 'empty' })
  })

  test('OR も相手駒は複数指定できない (`?[rb]` は DSL に無い)', () => {
    expect(
      normalizeCell({
        kind: 'orPieces',
        pieces: [PieceType.ROOK, PieceType.BISHOP],
        side: 'opponent',
      }),
    ).toEqual({ kind: 'orPieces', pieces: [PieceType.ROOK], side: 'opponent' })
  })

  test('OR も駒を選んでいなければ無指定に落ちる', () => {
    expect(normalizeCell({ kind: 'orPieces', pieces: [], side: 'own' })).toEqual({
      kind: 'unspecified',
    })
  })
})

describe('flipCellSide', () => {
  test('単一駒は先後を入れ替えられる', () => {
    const own = cellFromToken('G')
    expect(own).not.toBeNull()
    if (own === null) return
    const flipped = flipCellSide(own)
    expect(flipped).not.toBeNull()
    if (flipped === null) return
    expect(tokenFromCell(flipped)).toBe('g')
    const back = flipCellSide(flipped)
    expect(back).not.toBeNull()
    if (back === null) return
    expect(tokenFromCell(back)).toBe('G')
  })

  test('OR も単一駒なら入れ替えられる', () => {
    const own = cellFromToken('?R')
    if (own === null) throw new Error('unreachable')
    const flipped = flipCellSide(own)
    if (flipped === null) throw new Error('unreachable')
    expect(tokenFromCell(flipped)).toBe('?r')
  })

  test.each(['.', '_', '*', '[GS]', '[!GS]', '?[RB]'])(
    '先後を書き分けられないセルは null: %p',
    (token) => {
      const cell = cellFromToken(token)
      expect(cell).not.toBeNull()
      if (cell === null) return
      expect(flipCellSide(cell)).toBeNull()
    },
  )
})

describe('生成物の合法性', () => {
  const SIDES = ['own', 'opponent'] as const

  test('全組み合わせで、生成したトークンがパーサを通る', () => {
    const cells: DefinitionCell[] = PIECE_ORDER.flatMap((piece, index) =>
      SIDES.flatMap((side) =>
        [false, true].map((negated): DefinitionCell => {
          const second = PIECE_ORDER[(index + 1) % PIECE_ORDER.length]
          const third = PIECE_ORDER[(index + 2) % PIECE_ORDER.length]
          const pieces = [piece, second, third].filter((p) => p !== undefined)
          return { kind: 'pieces', pieces: pieces.slice(0, (index % 3) + 1), side, negated }
        }),
      ),
    )

    // OR も同じ組み合わせで回す (相手駒 x 複数駒は normalizeCell が詰める)
    const orCells: DefinitionCell[] = cells.flatMap((cell) =>
      cell.kind === 'pieces' && !cell.negated
        ? [{ kind: 'orPieces', pieces: cell.pieces, side: cell.side }]
        : [],
    )

    const tokens = [
      ...cells,
      ...orCells,
      { kind: 'unspecified' } as const,
      { kind: 'empty' } as const,
      { kind: 'anyPiece' } as const,
    ].map(tokenFromCell)

    for (const token of tokens) {
      // 生成したトークンは必ず読み戻せる。
      expect(cellFromToken(token)).not.toBeNull()

      // グリッドに埋めてもパーサが例外を投げない。
      const row = [token, ...Array.from({ length: 8 }, () => '.')].join(' ')
      const dsl = ['=== name: テスト', ...Array.from({ length: 9 }, () => row)].join('\n')
      expect(() => parseDefinitionFile(dsl)).not.toThrow()
    }
  })

  test('PIECE_SFEN は 14 駒種を網羅する', () => {
    expect(PIECE_ORDER.length).toBe(14)
    expect(PIECE_SFEN.size).toBe(14)
    expect(PIECE_SFEN.get(PieceType.HORSE)).toBe('+B')
  })
})

/**
 * 抽出 + セル解釈がパーサ本体とズレていないことを、全定義で突き合わせる。
 * グリッド由来の要件だけを比べる (ヘッダ由来の kind は除外)。
 */
describe('全定義でパーサとの一致 (ドリフト検知)', () => {
  const GRID_KINDS = new Set(['exact', 'opponent', 'anyOf', 'notOf', 'empty', 'anyPiece'])

  test.each([...FILES])('%s', (file) => {
    const content = readFileSync(join(ASSETS, file), 'utf8')
    const lines = content.split('\n')
    const parsed = parseDefinitionFile(content)
    expect(parsed.length).toBeGreaterThan(0)

    for (const definition of parsed) {
      // 盤の形を持たない分類の節 (category: true) はグリッドが無いので比べるものが無い。
      if (definition.category) continue
      const source = lines.slice(definition.sourceStartLine - 1, definition.sourceEndLine).join('\n')
      const extraction = extractGrid(source)
      expect(extraction.ok).toBe(true)
      if (!extraction.ok) continue

      const mine = extraction.grid.rows
        .flatMap((row, rowIdx) =>
          row.cells.map((cell, colIdx) => {
            const state = cellFromToken(cell.token)
            expect(state).not.toBeNull()
            if (state === null || state.kind === 'unspecified') return null
            // `?X` は 1 セル = 1 要件にならないので、この升ごとの比較には乗らない。
            if (state.kind === 'orPieces') return null
            const pieces = state.kind === 'pieces' ? state.pieces : []
            const kind =
              state.kind === 'empty'
                ? 'empty'
                : state.kind === 'anyPiece'
                  ? 'anyPiece'
                  : state.side === 'opponent'
                    ? 'opponent'
                    : state.negated
                      ? 'notOf'
                      : pieces.length > 1
                        ? 'anyOf'
                        : 'exact'
            return `${9 - colIdx}${rowIdx + 1}:${kind}:${pieces.join(',')}`
          }),
        )
        .filter((entry) => entry !== null)
        .sort()

      const theirs = definition.placements
        .filter((placement) => GRID_KINDS.has(placement.kind))
        .map(
          (placement) =>
            `${placement.file}${placement.rank}:${placement.kind}:${placement.pieceTypes.join(',')}`,
        )
        .sort()

      expect(mine).toEqual(theirs)

      // OR (`?X`) は同じ駒指定のセルが 1 件にまとまるので、群ごとに升の並びを比べる。
      const orMine = new Map<string, string[]>()
      for (const [rowIdx, row] of extraction.grid.rows.entries()) {
        for (const [colIdx, cell] of row.cells.entries()) {
          const state = cellFromToken(cell.token)
          if (state === null || state.kind !== 'orPieces') continue
          const kind = state.side === 'opponent' ? 'opponentInSquares' : 'pieceInSquares'
          const key = `${kind}:${[...state.pieces].sort().join(',')}`
          orMine.set(key, [...(orMine.get(key) ?? []), `${9 - colIdx}${rowIdx + 1}`])
        }
      }

      const orTheirs = new Map(
        definition.placements
          .filter(
            (placement) =>
              placement.kind === 'pieceInSquares' || placement.kind === 'opponentInSquares',
          )
          .map(
            (placement) =>
              [
                `${placement.kind}:${[...placement.pieceTypes].sort().join(',')}`,
                placement.squares.map((square) => `${square.file}${square.rank}`),
              ] as const,
          ),
      )

      expect([...orMine].sort()).toEqual([...orTheirs].sort())
    }
  })
})
