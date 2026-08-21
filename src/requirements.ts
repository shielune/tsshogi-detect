/**
 * 囲いテンプレートを構成する要件 (tsshogi-dart lib/src/castle.dart の移植)。
 *
 * 要件は 3 系統。
 *  1. 盤上 1 マスへの要件 — file/rank は先手視点で持ち、後手判定では 180° 回転する
 *  2. 盤面・持駒全体への要件 — マスに紐づかず回転もしない
 *  3. 履歴依存要件 — MoveHistory が無いと判定できず、局面だけの検出では常に false
 */

import { Color, type ImmutablePosition, PieceType, Square, unpromotedPieceType } from 'tsshogi'
import type { MoveHistory } from './move-history.ts'

/** 先手視点の座標を side 視点に変換する。後手なら 180° 回転。 */
export function rotate(file: number, rank: number, side: Color): Square {
  return side === Color.BLACK ? new Square(file, rank) : new Square(10 - file, 10 - rank)
}

export interface CastleRequirement {
  readonly kind: string
  isSatisfiedBy(position: ImmutablePosition, side: Color, history?: MoveHistory): boolean
}

/** 駒種を厳密に指定する 1 マスの要件。 */
export class PiecePlacement implements CastleRequirement {
  readonly kind = 'piece'
  readonly file: number
  readonly rank: number
  readonly pieceType: PieceType
  /** テンプレ視点の絶対色。BLACK はテンプレ自陣、WHITE はテンプレ相手陣の駒。 */
  readonly color: Color

  constructor(file: number, rank: number, pieceType: PieceType, color: Color = Color.BLACK) {
    this.file = file
    this.rank = rank
    this.pieceType = pieceType
    this.color = color
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    const piece = position.board.at(rotate(this.file, this.rank, side))
    if (piece === null) return false
    const expected =
      this.color === Color.BLACK ? side : side === Color.BLACK ? Color.WHITE : Color.BLACK
    return piece.color === expected && piece.type === this.pieceType
  }
}

/** 候補駒種のいずれかにマッチする 1 マスの要件 (テンプレ `[GS]`)。 */
export class AnyOfPieces implements CastleRequirement {
  readonly kind = 'anyOf'
  readonly file: number
  readonly rank: number
  readonly options: readonly PieceType[]

  constructor(file: number, rank: number, options: readonly PieceType[]) {
    this.file = file
    this.rank = rank
    this.options = options
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    const piece = position.board.at(rotate(this.file, this.rank, side))
    if (piece === null || piece.color !== side) return false
    return this.options.includes(piece.type)
  }
}

/** 指定マスが完全に空であることを要求する (テンプレ `_`)。 */
export class EmptySquare implements CastleRequirement {
  readonly kind = 'empty'
  readonly file: number
  readonly rank: number

  constructor(file: number, rank: number) {
    this.file = file
    this.rank = rank
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    return position.board.at(rotate(this.file, this.rank, side)) === null
  }
}

/** 指定マスに side の除外駒種が無いことを要求する (テンプレ `[!GS]`)。空マスや相手駒は満たす。 */
export class NotOfPieces implements CastleRequirement {
  readonly kind = 'notOf'
  readonly file: number
  readonly rank: number
  readonly excluded: readonly PieceType[]

  constructor(file: number, rank: number, excluded: readonly PieceType[]) {
    this.file = file
    this.rank = rank
    this.excluded = excluded
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    const piece = position.board.at(rotate(this.file, this.rank, side))
    if (piece === null || piece.color !== side) return true
    return !this.excluded.includes(piece.type)
  }
}

/** 指定マスに side の駒が種類を問わずあることを要求する (テンプレ `*`)。 */
export class AnyPiece implements CastleRequirement {
  readonly kind = 'anyPiece'
  readonly file: number
  readonly rank: number

  constructor(file: number, rank: number) {
    this.file = file
    this.rank = rank
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    const piece = position.board.at(rotate(this.file, this.rank, side))
    return piece !== null && piece.color === side
  }
}

/** side の指定駒種が盤上のどこかにあることを要求する。マスに紐づかないので回転しない。 */
export class PieceAnywhere implements CastleRequirement {
  readonly kind = 'anywhere'
  readonly pieceType: PieceType

  constructor(pieceType: PieceType) {
    this.pieceType = pieceType
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    return position.board.listNonEmptySquares().some((square) => {
      const piece = position.board.at(square)
      return piece !== null && piece.color === side && piece.type === this.pieceType
    })
  }
}

/** side が指定駒を持駒に minCount 枚以上持つことを要求する。 */
export class HandPiece implements CastleRequirement {
  readonly kind = 'hand'
  readonly pieceType: PieceType
  readonly minCount: number

  constructor(pieceType: PieceType, minCount = 1) {
    this.pieceType = pieceType
    this.minCount = minCount
  }

  isSatisfiedBy(position: ImmutablePosition, side: Color): boolean {
    return position.hand(side).count(this.pieceType) >= this.minCount
  }
}

/** side が指定マスから一度も動いていないことを要求する (履歴依存)。 */
export class PieceUnmoved implements CastleRequirement {
  readonly kind = 'unmoved'
  readonly file: number
  readonly rank: number

  constructor(file: number, rank: number) {
    this.file = file
    this.rank = rank
  }

  isSatisfiedBy(_position: ImmutablePosition, side: Color, history?: MoveHistory): boolean {
    if (history === undefined) return false
    return history.isUnmoved(side, rotate(this.file, this.rank, side))
  }
}

/** side の指定駒種が指定マスを過去に通過したことを要求する (履歴依存)。 */
export class PieceVisited implements CastleRequirement {
  readonly kind = 'visited'
  readonly file: number
  readonly rank: number
  readonly pieceType: PieceType

  constructor(file: number, rank: number, pieceType: PieceType) {
    this.file = file
    this.rank = rank
    this.pieceType = pieceType
  }

  isSatisfiedBy(_position: ImmutablePosition, side: Color, history?: MoveHistory): boolean {
    if (history === undefined) return false
    return history.hasVisited(side, this.pieceType, rotate(this.file, this.rank, side))
  }
}

/**
 * 居玉 (bioshogi 同等)。玉が一度も動いていないか、玉の最初の移動が outbreak
 * (歩・角以外が初めて取られた手) 以降なら満たす。「戦いが始まるまで囲わなかった」
 * を含めて評価するので、このテンプレは game-end 評価に回す。
 */
export class KingIgyoku implements CastleRequirement {
  readonly kind = 'igyoku'

  isSatisfiedBy(_position: ImmutablePosition, side: Color, history?: MoveHistory): boolean {
    if (history === undefined) return false
    const kingMoved = history.kingFirstMovedTurn(side)
    if (kingMoved === undefined) return true
    const outbreak = history.outbreakTurn
    if (outbreak === undefined) return false
    return kingMoved >= outbreak
  }
}

const HISTORY_KINDS: ReadonlySet<string> = new Set(['unmoved', 'visited', 'igyoku'])

export function isHistoryRequirement(requirement: CastleRequirement): boolean {
  return HISTORY_KINDS.has(requirement.kind)
}

/** 取られた駒が outbreak (戦端) を開くか。歩・角は成駒に戻してから除外する。 */
export function opensHostilities(captured: PieceType): boolean {
  const basic = unpromotedPieceType(captured)
  return basic !== PieceType.PAWN && basic !== PieceType.BISHOP
}
