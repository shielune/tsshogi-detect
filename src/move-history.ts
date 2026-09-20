/**
 * 棋譜走査中に各駒の移動履歴を集計する (tsshogi-dart lib/src/move_history.dart の移植)。
 *
 * 履歴依存の要件 (PieceUnmoved / PieceVisited / KingIgyoku) と、盤にも持駒にも跡が
 * 残らない制約 (`no_drop:` / `bishop_exchange:`) はここを参照する。
 */

import {
  Color,
  type ImmutablePosition,
  type Move,
  PieceType,
  promotedPieceType,
  Square,
} from 'tsshogi'
import { opensHostilities } from './requirements.ts'

/** Square はインスタンス比較になるので、Set のキーには文字列を使う。 */
function key(color: Color, square: Square): string {
  return `${color}:${square.file}${square.rank}`
}

function squareKey(square: Square): string {
  return `${square.file}${square.rank}`
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
  /** 打たれた駒がそのまま乗っているマス → 打った側。動けばその升は外れる。 */
  private readonly dropped = new Map<string, Color>()
  /** 角か馬を取った最初の手数 (陣営ごと)。2 回目以降は交換の成否にも先後にも効かない。 */
  private readonly bishopCapture = new Map<Color, number>()

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
      // 動かした先はもう「打った駒の升」ではなく、動かした元は空く
      this.dropped.delete(squareKey(move.from))
      this.dropped.delete(squareKey(move.to))
    } else {
      this.dropped.set(squareKey(move.to), move.color)
    }

    this.visited.add(visitedKey(move.color, move.pieceType, move.to))
    // 成った手は、成る前の姿と成った姿の両方でその升に居たことになる。
    // 成る前だけだと ▲3三角成 で残るのは「角が 3三 に来た」だけで、
    // 「馬が 3三 に居た」はどこにも残らない
    if (move.promote) {
      this.visited.add(visitedKey(move.color, promotedPieceType(move.pieceType), move.to))
    }

    const captured = move.capturedPieceType
    if (captured === null) return
    if (this.outbreak === undefined && opensHostilities(captured)) {
      this.outbreak = ply
    }
    // 取ったのが角か馬なら角交換の片側。馬で来るのは成った角を取り返した側
    if (
      (captured === PieceType.BISHOP || captured === PieceType.HORSE) &&
      !this.bishopCapture.has(move.color)
    ) {
      this.bishopCapture.set(move.color, ply)
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

  /**
   * その升に、その陣営が打った駒がそのまま乗っているか。
   *
   * 覚えるのは升だけで、駒は追わない。打った駒がその後どこかへ動けばその升はもう
   * 打った駒の升ではないし、別の駒が動いて乗ってきた升も同じ。
   */
  isDropped(side: Color, square: Square): boolean {
    return this.dropped.get(squareKey(square)) === side
  }

  /**
   * 角交換が済んでいれば仕掛けた側 (先に角/馬を取ったほう) を返す。
   * 片方しか取っていなければ交換は成立していないので undefined。
   *
   * 角交換は盤にも持駒にも跡が残らない (取った角を打てば持駒から消える) ので、
   * 取った手数を覚えておかないと、交換が済んだかどうかも誰から仕掛けたかも言えない。
   */
  bishopExchangeInitiator(): Color | undefined {
    const black = this.bishopCapture.get(Color.BLACK)
    const white = this.bishopCapture.get(Color.WHITE)
    if (black === undefined || white === undefined) return undefined
    return black <= white ? Color.BLACK : Color.WHITE
  }
}
