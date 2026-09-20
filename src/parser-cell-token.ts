// テンプレ DSL のセルトークン (`.` `_` `*` `K` `+P` `[GS]` `[!GS]` `?r` …) 1 つ分の
// 解析。parser.ts の分割の一部で、盤面グリッドの 1 マスをどう読むかだけを持つ。

import type { PieceType } from 'tsshogi'
import { SFEN_PIECES, type PlacementKind, TemplateSyntaxError } from './parser-types.ts'

const SFEN_TOKEN_TO_PIECE: ReadonlyMap<string, PieceType> = new Map(
  SFEN_PIECES.flatMap(([token, piece]): (readonly [string, PieceType])[] => [
    [token, piece],
    [token.toLowerCase(), piece],
  ]),
)

function pieceTypeOf(token: string, line: number): PieceType {
  const piece = SFEN_TOKEN_TO_PIECE.get(token)
  if (piece === undefined) {
    throw new TemplateSyntaxError(`unknown piece token: "${token}"`, line)
  }
  return piece
}

/** `GS` → ['G', 'S'] / `G+R` → ['G', '+R'] / `+P +L` → ['+P', '+L']。 */
function tokenizeAlternation(inner: string, lineNo: number): string[] {
  const out: string[] = []
  // 直前が '+' だったら次の 1 文字と組にする、の 1 文字ずつの走査
  const pending = { plus: false }
  for (const c of inner) {
    if (pending.plus) {
      out.push(`+${c}`)
      pending.plus = false
      continue
    }
    if (c === ' ' || c === '\t' || c === ',') continue
    if (c === '+') {
      pending.plus = true
      continue
    }
    out.push(c)
  }
  if (pending.plus) {
    throw new TemplateSyntaxError(`dangling "+" in alternation "[${inner}]"`, lineNo)
  }
  return out
}

/** `p` や `+p` のような相手駒トークンか。末尾の文字だけ見る。 */
function isLowercasePieceToken(token: string): boolean {
  const last = token[token.length - 1]
  if (last === undefined) return false
  return last.toLowerCase() === last && last.toUpperCase() !== last
}

/**
 * `?` を剥がして中身を読み直す (`?r` → `r`、`?[RB]` → `[RB]`)。
 *
 * 中身に許すのは駒の指定だけ:
 *   - `?_` `?*` … 「どこかが空」「どこかに何かある」は盤のほぼ全局面で真になる
 *   - `?[!GS]` … 「どこかが金銀以外」も同様に、ほぼ何も縛らない
 *   - `?` 単体 … 駒が無い
 * どれも書けてしまうと「書いたのに効かない定義」になるので、その場で撥ねる。
 */
function parseOrCellToken(
  token: string,
  section: string,
  row: number,
  lineNo: number,
): { kind: PlacementKind; pieceTypes: readonly PieceType[] } {
  const inner = token.slice(1)
  const where = `section "${section}" row ${row}`
  if (inner === '') {
    throw new TemplateSyntaxError(`${where}: "?" needs a piece (e.g. "?r" or "?[RB]")`, lineNo)
  }
  const parsed = parseCellToken(inner, section, row, lineNo)
  if (parsed.kind === 'exact' || parsed.kind === 'anyOf') {
    return { kind: 'pieceInSquares', pieceTypes: parsed.pieceTypes }
  }
  if (parsed.kind === 'opponent') {
    return { kind: 'opponentInSquares', pieceTypes: parsed.pieceTypes }
  }
  throw new TemplateSyntaxError(
    `${where}: "?" takes a piece, not "${inner}" (a negated or empty OR matches almost any position)`,
    lineNo,
  )
}

function parseCellToken(
  token: string,
  section: string,
  row: number,
  lineNo: number,
): { kind: PlacementKind; pieceTypes: readonly PieceType[] } {
  if (token === '_') return { kind: 'empty', pieceTypes: [] }
  if (token === '*') return { kind: 'anyPiece', pieceTypes: [] }
  if (token.startsWith('?')) return parseOrCellToken(token, section, row, lineNo)
  if (token.startsWith('[')) {
    if (!token.endsWith(']')) {
      throw new TemplateSyntaxError(
        `section "${section}" row ${row}: unterminated alternation: "${token}"`,
        lineNo,
      )
    }
    const inner = token.slice(1, -1)
    if (inner === '') {
      throw new TemplateSyntaxError(
        `section "${section}" row ${row}: empty alternation "[]"`,
        lineNo,
      )
    }
    const negated = inner.startsWith('!')
    const body = negated ? inner.slice(1) : inner
    if (body === '') {
      throw new TemplateSyntaxError(
        `section "${section}" row ${row}: empty exclusion in "[!]"`,
        lineNo,
      )
    }
    const pieces = tokenizeAlternation(body, lineNo).map((t) => pieceTypeOf(t, lineNo))
    if (pieces.length === 0) {
      throw new TemplateSyntaxError(
        `section "${section}" row ${row}: empty alternation in "${token}"`,
        lineNo,
      )
    }
    return { kind: negated ? 'notOf' : 'anyOf', pieceTypes: pieces }
  }
  if (isLowercasePieceToken(token)) {
    // 小文字トークンは相手駒 (bioshogi の `v駒` 相当)。
    return { kind: 'opponent', pieceTypes: [pieceTypeOf(token.toUpperCase(), lineNo)] }
  }
  return { kind: 'exact', pieceTypes: [pieceTypeOf(token, lineNo)] }
}

/** グリッド 1 セル分の解析結果 (エディタ用)。 */
export type CellTokenParse = {
  readonly kind: PlacementKind
  readonly pieceTypes: readonly PieceType[]
}

/**
 * セルトークンを 1 つだけ解析する。定義エディタが「このセルは今どういう指定か」を
 * 知るための入口で、文法違反は例外ではなく null で返す。`.` (無指定) は
 * finalizeSection がスキップする側なのでここでは扱わない。
 */
export function tryParseCellToken(token: string): CellTokenParse | null {
  try {
    return parseCellToken(token, '', 0, 0)
  } catch (error) {
    if (error instanceof TemplateSyntaxError) return null
    throw error
  }
}

export { parseCellToken, pieceTypeOf }
