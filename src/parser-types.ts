// テンプレ DSL パーサの中間表現 (PlacementCell 等) と、複数のパース用ファイルが
// 共有する小さなユーティリティ。
//
// parser.ts の分割の一部。セルトークンの解析は parser-cell-token.ts、`finish:` の
// 解析は parser-finish.ts、それ以外のヘッダとセクション状態は parser-header.ts に
// 分けてあり、このファイルはどれにも属さない土台 (型・SFEN トークン表・数値検証) を持つ。

import { PieceType } from 'tsshogi'
import type { BishopExchange, FormationSide, TemplateFinishCapture, TemplateSquare } from './template.ts'

export class TemplateSyntaxError extends Error {
  /** エラーの起きた行番号 (1 始まり)。 */
  readonly line: number

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'TemplateSyntaxError'
    this.line = line
  }
}

/** 要件の種類。値は Python / Dart 版の文字列をそのまま使う (突き合わせのため)。 */
export type PlacementKind =
  | 'exact'
  | 'opponent'
  | 'anyOf'
  | 'notOf'
  | 'empty'
  | 'anyPiece'
  | 'pieceAnywhere'
  | 'handPiece'
  | 'pieceUnmoved'
  | 'pieceVisited'
  | 'kingIgyoku'
  // `?X` (升をまたいだ OR)。自駒と相手駒を別の kind にしてあるのは、セルトークンの
  // 解析結果が {kind, pieceTypes} しか運べず、色を載せる場所が kind しか無いため
  // (exact / opponent が分かれているのと同じ理由)。
  | 'pieceInSquares'
  | 'opponentInSquares'

/** 要件 1 件分の中間表現。per-cell と position-wide を 1 つの型で表す。 */
export type PlacementCell = {
  readonly kind: PlacementKind
  readonly file: number
  readonly rank: number
  readonly pieceTypes: readonly PieceType[]
  readonly minCount: number
  /**
   * OR 要件 (`?X`) の対象升。他の kind では常に空。
   *
   * OR だけは 1 セル = 1 要件が崩れる (同じ駒指定の `?` セルが 1 件にまとまる) ので、
   * 升は file/rank ではなくここに並ぶ。
   */
  readonly squares: readonly TemplateSquare[]
}

/**
 * 成立を認める最終手 1 件 (`finish:`)。from が null なら移動元は問わない
 * (着地升だけを縛る、`finish:` 本来の形)。
 */
export type ParsedFinishMove = {
  readonly from: TemplateSquare | null
  readonly to: TemplateSquare
  /** 取った駒の指定 (`x R` / `x *` / `x _`)。null なら問わない。 */
  readonly capture: TemplateFinishCapture | null
  /** 成った手に限るか (`3 3 +`)。false なら成/不成を問わない。 */
  readonly promote: boolean
  /** 打った手に限るか (`3 3 打`)。false なら打ちも盤上の手も当たる。 */
  readonly drop: boolean
}

/** パース結果の 1 テンプレ。 */
export type ParsedTemplate = {
  readonly name: string
  readonly parent: string | null
  readonly aliases: readonly string[]
  readonly side: FormationSide | null
  /** 盤の形を持たない分類の節 (`category: true`)。placements は必ず空になる。 */
  readonly category: boolean
  readonly placements: readonly PlacementCell[]
  readonly plyEq: number | null
  readonly plyMin: number | null
  readonly plyMax: number | null
  readonly evaluateAtGameEnd: boolean
  /** 打った駒を含む形での成立を認めない (`no_drop: true`)。 */
  readonly noDrop: boolean
  /** 角交換が済んでいることを求める (`bishop_exchange:`)。null なら問わない。 */
  readonly bishopExchange: BishopExchange | null
  /** 成立を認める最終手 (`finish:`)。空なら制限なし。 */
  readonly finishMoves: readonly ParsedFinishMove[]
  /** `=== name:` 行の行番号 (1 始まり)。 */
  readonly sourceStartLine: number
  /** セクション末尾の行番号 (次セクションの直前、最後は本文の末尾)。 */
  readonly sourceEndLine: number
}

// `K` / `+P` のような SFEN 風トークン → 駒種。小文字も同じ駒種に落ちる
// (相手駒の判定はセルトークン側で行う)。
export const SFEN_PIECES: readonly (readonly [string, PieceType])[] = [
  ['P', PieceType.PAWN],
  ['L', PieceType.LANCE],
  ['N', PieceType.KNIGHT],
  ['S', PieceType.SILVER],
  ['G', PieceType.GOLD],
  ['B', PieceType.BISHOP],
  ['R', PieceType.ROOK],
  ['K', PieceType.KING],
  ['+P', PieceType.PROM_PAWN],
  ['+L', PieceType.PROM_LANCE],
  ['+N', PieceType.PROM_KNIGHT],
  ['+S', PieceType.PROM_SILVER],
  ['+B', PieceType.HORSE],
  ['+R', PieceType.DRAGON],
]

export function cell(kind: PlacementKind, partial: Partial<Omit<PlacementCell, 'kind'>>): PlacementCell {
  return { kind, file: 0, rank: 0, pieceTypes: [], minCount: 1, squares: [], ...partial }
}

export function isDigits(text: string | undefined): boolean {
  return text !== undefined && /^\d+$/.test(text)
}
