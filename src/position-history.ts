/**
 * 局面 1 枚しか無いときの履歴の代わり。
 *
 * 指し手を辿っていないので「初期位置に居る駒は動いていない」という近似になる。
 * これが盤面 1 枚から検出するときの意味論で、棋譜を走査する側 (scan.ts) は
 * 本物の MoveHistory を使う。
 */

import { type Color, type ImmutablePosition, type PieceType, Position, type Square } from 'tsshogi'
import { MoveHistory } from './move-history.ts'

/** 平手の初期配置。「初期位置に居た駒」を引くための定数。 */
const INITIAL_POSITION = new Position()

/** その局面のその升に、その陣営のその駒種が乗っているか。 */
function standsAt(
  position: ImmutablePosition,
  side: Color,
  pieceType: PieceType,
  square: Square,
): boolean {
  const piece = position.board.at(square)
  return piece !== null && piece.color === side && piece.type === pieceType
}

/**
 * 局面だけから起こす履歴。
 *
 * visited 集合の中身は「平手に居た ∪ 今居る」でしかないので、集合は作らず
 * **問われた升だけ盤を 2 回引く**。作るのが O(1) になるぶん、走査中に毎手作っても効かない。
 *
 * sourceTouched を積まないので isUnmoved は常に真、kingFirstMovedTurn と outbreakTurn は
 * undefined、isDropped は常に偽、bishopExchangeInitiator も undefined。どれも
 * 「指し手を見ていないので言えない」の側に倒してある。
 */
export class PositionOnlyHistory extends MoveHistory {
  private readonly position: ImmutablePosition

  constructor(position: ImmutablePosition) {
    super()
    this.position = position
  }

  override hasVisited(side: Color, pieceType: PieceType, square: Square): boolean {
    return (
      standsAt(INITIAL_POSITION, side, pieceType, square) ||
      standsAt(this.position, side, pieceType, square)
    )
  }
}

/**
 * 局面 1 つにつき 1 個を使い回す。中身は問われたときに盤を引くだけなので、
 * 走査で同じ Position を進めていっても答えは常に今の盤のものになる。
 */
const CACHE = new WeakMap<ImmutablePosition, PositionOnlyHistory>()

export function positionOnlyHistory(position: ImmutablePosition): PositionOnlyHistory {
  const cached = CACHE.get(position)
  if (cached !== undefined) return cached
  const created = new PositionOnlyHistory(position)
  CACHE.set(position, created)
  return created
}
