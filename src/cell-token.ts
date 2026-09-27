// グリッド 1 セルの状態モデルと、DSL トークンとの相互変換。
//
// 盤面エディタはこの型でセルを持ち、tokenFromCell で必ず「パーサが受理する
// トークン」に落とす。つまり盤面操作が DSL を壊すことは構造的に起きない。
//
// 注意: anyOf / anyPiece は tsshogi-detect 側で暗黙に「自駒」文脈として判定される
// (requirements.ts が piece.color !== side で弾く)。除外は色を書ける —
// [!GS] は「自駒の金銀でない」で空マスも相手駒も満たし、[!r] は「相手の飛車でない」で
// 空マスも自駒も満たす。色を書けないのは複数駒の並び [GS] だけなので、先後を反転
// できないのもそこに限る。

import type { PieceType } from 'tsshogi'
import { SFEN_PIECES, tryParseCellToken } from './parser.ts'

export type CellSide = 'own' | 'opponent'

export type DefinitionCell =
  | { readonly kind: 'unspecified' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'anyPiece' }
  | {
      readonly kind: 'pieces'
      /** 1 個以上。並び順は DSL の記述順のまま保つ (無用な diff を出さないため)。 */
      readonly pieces: readonly PieceType[]
      readonly side: CellSide
      readonly negated: boolean
    }
  /**
   * 升をまたいだ OR (`?X`)。**この升 1 つでは要件にならない** — 同じ駒指定を書いた
   * 升が集まって「そのどれか 1 つ」という 1 件になる。
   *
   * pieces と分けてあるのは意図的で、フラグ 1 つ足す形にすると `kind === 'pieces'`
   * を見ている箇所 (掴めるか・駒を要求しているか) が黙って OR も拾ってしまう。
   * 別の kind にしておけば、switch の網羅チェックが漏れを全部指してくれる。
   */
  | {
      readonly kind: 'orPieces'
      readonly pieces: readonly PieceType[]
      readonly side: CellSide
    }

/** パレットに並べる順。生駒 8 種 → 成駒 6 種。 */
export const PIECE_ORDER: readonly PieceType[] = SFEN_PIECES.map(([, piece]) => piece)

/** 駒種 → 大文字 SFEN トークン (`G` / `+R`)。 */
export const PIECE_SFEN: ReadonlyMap<PieceType, string> = new Map(
  SFEN_PIECES.map(([token, piece]) => [piece, token] as const),
)

/** DSL トークン 1 つをセル状態にする。解釈できなければ null。 */
export function cellFromToken(token: string): DefinitionCell | null {
  if (token === '.') return { kind: 'unspecified' }

  const parsed = tryParseCellToken(token)
  if (parsed === null) return null

  switch (parsed.kind) {
    case 'empty':
      return { kind: 'empty' }
    case 'anyPiece':
      return { kind: 'anyPiece' }
    case 'exact':
      return { kind: 'pieces', pieces: parsed.pieceTypes, side: 'own', negated: false }
    case 'opponent':
      return { kind: 'pieces', pieces: parsed.pieceTypes, side: 'opponent', negated: false }
    case 'anyOf':
      return { kind: 'pieces', pieces: parsed.pieceTypes, side: 'own', negated: false }
    case 'notOf':
      return { kind: 'pieces', pieces: parsed.pieceTypes, side: 'own', negated: true }
    case 'opponentNotOf':
      return { kind: 'pieces', pieces: parsed.pieceTypes, side: 'opponent', negated: true }
    case 'pieceInSquares':
      return { kind: 'orPieces', pieces: parsed.pieceTypes, side: 'own' }
    case 'opponentInSquares':
      return { kind: 'orPieces', pieces: parsed.pieceTypes, side: 'opponent' }
    default:
      // セルトークンからは生成されない kind (handPiece 等)。
      return null
  }
}

/**
 * 相手駒を並べられるのは除外 (`[!gs]`) だけなので、はみ出した組み合わせを矯正する。
 * 駒を 1 つも選んでいない状態は「無指定」に落とす。
 */
export function normalizeCell(cell: DefinitionCell): DefinitionCell {
  if (cell.kind === 'orPieces') {
    const first = cell.pieces[0]
    if (first === undefined) return { kind: 'unspecified' }
    // `?r` の小文字は 1 駒しか書けない (相手駒の複数指定は DSL に無い)
    if (cell.side === 'opponent' && cell.pieces.length > 1) {
      return { kind: 'orPieces', pieces: [first], side: 'opponent' }
    }
    return cell
  }
  if (cell.kind !== 'pieces') return cell
  const first = cell.pieces[0]
  if (first === undefined) return { kind: 'unspecified' }
  if (cell.side === 'opponent' && !cell.negated && cell.pieces.length > 1) {
    return { kind: 'pieces', pieces: [first], side: 'opponent', negated: false }
  }
  return cell
}

/** セル状態を DSL トークンにする。出力は必ず cellFromToken が受理する。 */
export function tokenFromCell(cell: DefinitionCell): string {
  const normalized = normalizeCell(cell)
  switch (normalized.kind) {
    case 'unspecified':
      return '.'
    case 'empty':
      return '_'
    case 'anyPiece':
      return '*'
    case 'pieces': {
      const sfens = normalized.pieces.map((piece) => PIECE_SFEN.get(piece) ?? '')
      if (normalized.negated) {
        const body = sfens.join('')
        return `[!${normalized.side === 'opponent' ? body.toLowerCase() : body}]`
      }
      if (normalized.side === 'opponent') return (sfens[0] ?? '').toLowerCase()
      if (sfens.length === 1) return sfens[0] ?? '.'
      return `[${sfens.join('')}]`
    }
    case 'orPieces': {
      const sfens = normalized.pieces.map((piece) => PIECE_SFEN.get(piece) ?? '')
      if (normalized.side === 'opponent') return `?${(sfens[0] ?? '').toLowerCase()}`
      if (sfens.length === 1) return `?${sfens[0] ?? ''}`
      return `?[${sfens.join('')}]`
    }
  }
}

/** 先手駒 ⇔ 後手駒を入れ替える。書き分けられないセルは null。 */
export function flipCellSide(cell: DefinitionCell): DefinitionCell | null {
  if (cell.kind === 'orPieces') {
    if (cell.pieces.length !== 1) return null
    return { ...cell, side: cell.side === 'own' ? 'opponent' : 'own' }
  }
  if (cell.kind !== 'pieces') return null
  // 除外は何駒でも色を書ける。並べる側は 1 駒のときだけ (`[GS]` の小文字版は無い)
  if (!cell.negated && cell.pieces.length !== 1) return null
  return { ...cell, side: cell.side === 'own' ? 'opponent' : 'own' }
}
