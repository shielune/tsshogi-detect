/**
 * 棋譜走査中に各駒の移動履歴を集計する (tsshogi-dart lib/src/move_history.dart の移植)。
 *
 * 履歴依存の要件 (PieceUnmoved / PieceVisited / KingIgyoku) はここを参照する。
 */

import { type Color, type ImmutablePosition, type Move, PieceType, Square } from 'tsshogi'
import { opensHostilities } from './requirements.ts'

/** Square はインスタンス比較になるので、Set のキーには文字列を使う。 */
function key(color: Color, square: Square): string {
  return `${color}:${square.file}${square.rank}`
}

function visitedKey(color: Color, pieceType: PieceType, square: Square): string {
  return `${color}:${pieceType}:${square.file}${square.rank}`
}

export class MoveHistory {
  /** そのマスから一度でも move.from として動かれたか。 */
  private readonly sourceTouched = new Set<string>()
  /** その陣営のその駒種が居たことのあるマス。初期配置と各 move.to を貯める。 */
  private readonly visited = new Set<string>()
  private readonly kingFirstMoved = new Map<Color, number>()
  /** 歩・角以外が初めて取られた手数 (bioshogi の outbreak_turn)。 */
  private outbreak: number | undefined = undefined

  /** 初期局面の駒配置で履歴を初期化する。sourceTouched は空のまま。 */
  initFromPosition(position: ImmutablePosition): void {
    for (const square of position.board.listNonEmptySquares()) {
      const piece = position.board.at(square)
      if (piece !== null) this.visited.add(visitedKey(piece.color, piece.type, square))
    }
  }

  /** ply 手目として move を適用したときの履歴更新。do_move の *前* に呼ぶこと。 */
  recordMove(move: Move, ply: number): void {
    if (move.from instanceof Square) {
      this.sourceTouched.add(key(move.color, move.from))
      if (move.pieceType === PieceType.KING && !this.kingFirstMoved.has(move.color)) {
        this.kingFirstMoved.set(move.color, ply)
      }
    }
    this.visited.add(visitedKey(move.color, move.pieceType, move.to))

    if (
      move.capturedPieceType !== null &&
      this.outbreak === undefined &&
      opensHostilities(move.capturedPieceType)
    ) {
      this.outbreak = ply
    }
  }

  isUnmoved(side: Color, square: Square): boolean {
    return !this.sourceTouched.has(key(side, square))
  }

  hasVisited(side: Color, pieceType: PieceType, square: Square): boolean {
    return this.visited.has(visitedKey(side, pieceType, square))
  }

  kingFirstMovedTurn(side: Color): number | undefined {
    return this.kingFirstMoved.get(side)
  }

  get outbreakTurn(): number | undefined {
    return this.outbreak
  }
}
