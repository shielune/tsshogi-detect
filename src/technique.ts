/**
 * 手筋検出。
 *
 * 基礎94件は tsshogi-dart の Technique 実装と同じ判定を TypeScript へ移植し、
 * そこへ 1手 + 前後局面だけで客観的に判定できる9件を追加している。
 * 評価値や主観が必要な概念はここでは扱わない。
 */

import {
  Color,
  Direction,
  directions,
  type ImmutablePosition,
  type Move,
  MoveType,
  movableDirections,
  Piece,
  PieceType,
  Position,
  promotedPieceType,
  resolveMoveType,
  reverseColor,
  reverseDirection,
  Square,
  vectorToDirectionAndDistance,
} from 'tsshogi'

export interface TechniqueTemplate {
  readonly name: string
  readonly aliases?: readonly string[]
  matches(move: Move, before: ImmutablePosition, after: ImmutablePosition): boolean
}

export interface DetectedTechnique {
  readonly template: TechniqueTemplate
  readonly ply: number
  readonly color: Color
}

type Matcher = (move: Move, before: ImmutablePosition, after: ImmutablePosition) => boolean

function technique(name: string, matches: Matcher, aliases: readonly string[] = []): TechniqueTemplate {
  return { name, aliases, matches }
}

function isDrop(move: Move): boolean {
  return !(move.from instanceof Square)
}

function front(square: Square, color: Color, step = 1): Square | undefined {
  const result =
    color === Color.BLACK
      ? new Square(square.file, square.rank - step)
      : new Square(square.file, square.rank + step)
  return result.valid ? result : undefined
}

function back(square: Square, color: Color, step = 1): Square | undefined {
  const result =
    color === Color.BLACK
      ? new Square(square.file, square.rank + step)
      : new Square(square.file, square.rank - step)
  return result.valid ? result : undefined
}

function isInPromotionZone(color: Color, rank: number): boolean {
  return color === Color.BLACK ? rank <= 3 : rank >= 7
}

function isInOwnCamp(color: Color, rank: number): boolean {
  return color === Color.BLACK ? rank >= 7 : rank <= 3
}

const GOLD_LIKE: readonly PieceType[] = [
  PieceType.GOLD,
  PieceType.PROM_PAWN,
  PieceType.PROM_LANCE,
  PieceType.PROM_KNIGHT,
  PieceType.PROM_SILVER,
]
const ROOK_LIKE: readonly PieceType[] = [PieceType.ROOK, PieceType.DRAGON]
const BISHOP_LIKE: readonly PieceType[] = [PieceType.BISHOP, PieceType.HORSE]

function movedPieceType(move: Move): PieceType {
  return move.promote ? promotedPieceType(move.pieceType) : move.pieceType
}

function countEnemyTargetsFrom(
  position: ImmutablePosition,
  from: Square,
  piece: Piece,
): number {
  let count = 0
  for (const direction of movableDirections(piece)) {
    const moveType = resolveMoveType(piece, direction)
    if (moveType === undefined) continue
    let square = from.neighbor(direction)
    let step = 0
    while (square.valid) {
      step += 1
      const target = position.board.at(square)
      if (target !== null) {
        if (target.color !== piece.color && target.type !== PieceType.KING) count += 1
        break
      }
      if (moveType === MoveType.SHORT) break
      square = square.neighbor(direction)
      if (step > 8) break
    }
  }
  return count
}

function scanForEnemyTypes(
  position: ImmutablePosition,
  from: Square,
  piece: Piece,
  targets: readonly PieceType[],
): boolean {
  for (const direction of movableDirections(piece)) {
    const moveType = resolveMoveType(piece, direction)
    if (moveType === undefined) continue
    let square = from.neighbor(direction)
    let step = 0
    while (square.valid) {
      step += 1
      const target = position.board.at(square)
      if (target !== null) {
        if (target.color !== piece.color && targets.includes(target.type)) return true
        break
      }
      if (moveType === MoveType.SHORT) break
      square = square.neighbor(direction)
      if (step > 8) break
    }
  }
  return false
}

function countPowerSources(
  position: ImmutablePosition,
  target: Square,
  color: Color,
  ignore?: Square,
): number {
  let count = 0
  for (const direction of directions) {
    let step = 0
    let square = target.neighbor(direction)
    while (square.valid) {
      step += 1
      if (ignore?.equals(square)) {
        square = square.neighbor(direction)
        continue
      }
      const piece = position.board.at(square)
      if (piece !== null) {
        if (piece.color === color) {
          const moveType = resolveMoveType(piece, reverseDirection(direction))
          if (moveType === MoveType.LONG || (moveType === MoveType.SHORT && step === 1)) {
            count += 1
          }
        }
        break
      }
      square = square.neighbor(direction)
    }
  }
  return count
}

function enemyKing(move: Move, position: ImmutablePosition): Square | undefined {
  return position.board.findKing(reverseColor(move.color))
}

function checkAndTarget(requireCheck: boolean, targets: readonly PieceType[]): Matcher {
  return (move, _before, after) => {
    const enemy = reverseColor(move.color)
    if (after.board.isChecked(enemy) !== requireCheck) return false
    return scanForEnemyTypes(after, move.to, new Piece(move.color, movedPieceType(move)), targets)
  }
}

function giri(pieceTypes: readonly PieceType[]): Matcher {
  return (move, _before, after) =>
    pieceTypes.includes(move.pieceType) && after.board.hasPower(move.to, reverseColor(move.color))
}

function matchup(attackerTypes: readonly PieceType[], capturedType: PieceType): Matcher {
  return (move) => attackerTypes.includes(move.pieceType) && move.capturedPieceType === capturedType
}

function narazu(pieceType: PieceType): Matcher {
  return (move) => {
    if (!(move.from instanceof Square)) return false
    if (move.pieceType !== pieceType || move.promote) return false
    return (
      isInPromotionZone(move.color, move.from.rank) || isInPromotionZone(move.color, move.to.rank)
    )
  }
}

const LONG_DIRECTIONS: readonly Direction[] = [
  Direction.UP,
  Direction.DOWN,
  Direction.LEFT,
  Direction.RIGHT,
  Direction.LEFT_UP,
  Direction.RIGHT_UP,
  Direction.LEFT_DOWN,
  Direction.RIGHT_DOWN,
]

interface LongCheck {
  checker: Square
  piece: Piece
  between: Square[]
}

function longChecks(position: ImmutablePosition, kingColor: Color): LongCheck[] {
  const king = position.board.findKing(kingColor)
  if (king === undefined) return []
  const result: LongCheck[] = []
  for (const direction of LONG_DIRECTIONS) {
    const between: Square[] = []
    let square = king.neighbor(direction)
    while (square.valid) {
      const piece = position.board.at(square)
      if (piece === null) {
        between.push(square)
        square = square.neighbor(direction)
        continue
      }
      if (piece.color !== kingColor) {
        const moveType = resolveMoveType(piece, reverseDirection(direction))
        if (moveType === MoveType.LONG) result.push({ checker: square, piece, between })
      }
      break
    }
  }
  return result
}

function rayHasEnemy(
  position: ImmutablePosition,
  origin: Square,
  direction: Direction,
  color: Color,
): boolean {
  let square = origin.neighbor(direction)
  while (square.valid) {
    const piece = position.board.at(square)
    if (piece !== null) return piece.color !== color
    square = square.neighbor(direction)
  }
  return false
}

function pieceAttacksSquare(position: ImmutablePosition, origin: Square, target: Square): boolean {
  const piece = position.board.at(origin)
  if (piece === null) return false
  const vector = vectorToDirectionAndDistance(target.x - origin.x, target.y - origin.y)
  if (!vector.ok) return false
  const moveType = resolveMoveType(piece, vector.direction)
  if (moveType === undefined) return false
  if (moveType === MoveType.SHORT) return vector.distance === 1
  let square = origin.neighbor(vector.direction)
  for (let step = 1; step < vector.distance; step += 1) {
    if (position.board.at(square) !== null) return false
    square = square.neighbor(vector.direction)
  }
  return true
}

export const KNOWN_TECHNIQUES: readonly TechniqueTemplate[] = [
  technique(
    'たたきの歩',
    (move, before) => {
      if (!isDrop(move) || move.pieceType !== PieceType.PAWN) return false
      const f = front(move.to, move.color)
      if (f === undefined) return false
      const piece = before.board.at(f)
      return piece !== null && piece.color !== move.color
    },
    ['叩きの歩'],
  ),
  technique('垂れ歩', (move) =>
    isDrop(move) &&
    move.pieceType === PieceType.PAWN &&
    move.to.rank === (move.color === Color.BLACK ? 4 : 6),
  ),
  technique('底歩', (move) =>
    isDrop(move) &&
    move.pieceType === PieceType.PAWN &&
    move.to.rank === (move.color === Color.BLACK ? 9 : 1),
  ),
  technique('金底の歩', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.PAWN) return false
    if (move.to.rank !== (move.color === Color.BLACK ? 9 : 1)) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color === move.color && piece.type === PieceType.GOLD
  }),
  technique('金底の香', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.LANCE) return false
    if (move.to.rank !== (move.color === Color.BLACK ? 9 : 1)) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color === move.color && piece.type === PieceType.GOLD
  }),
  technique('下段の香', (move) =>
    isDrop(move) &&
    move.pieceType === PieceType.LANCE &&
    move.to.rank === (move.color === Color.BLACK ? 9 : 1),
  ),
  technique('底歩に香', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.LANCE) return false
    if (!isInOwnCamp(move.color, move.to.rank)) return false
    const backRank = move.color === Color.BLACK ? 9 : 1
    const piece = before.board.at(new Square(move.to.file, backRank))
    return piece !== null && piece.color === move.color && piece.type === PieceType.PAWN
  }),
  technique('合わせの歩', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.PAWN) return false
    for (let rank = 1; rank <= 9; rank += 1) {
      if (rank === move.to.rank) continue
      const piece = before.board.at(new Square(move.to.file, rank))
      if (piece !== null && piece.color !== move.color && piece.type === PieceType.PAWN) return true
    }
    return false
  }),
  technique('桂頭の歩', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.PAWN) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.KNIGHT
  }),
  technique('控えの歩', (move) => {
    if (!isDrop(move) || move.pieceType !== PieceType.PAWN) return false
    return move.color === Color.BLACK ? [7, 8].includes(move.to.rank) : [2, 3].includes(move.to.rank)
  }),
  technique('突き捨て', (move, _before, after) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.PAWN) return false
    if (move.capturedPieceType !== null) return false
    return after.board.hasPower(move.to, reverseColor(move.color))
  }),
  technique('突き違いの歩', (move) => {
    if (!(move.from instanceof Square)) return false
    return (
      move.pieceType === PieceType.PAWN &&
      move.capturedPieceType === PieceType.PAWN &&
      move.from.file !== move.to.file
    )
  }),
  technique('連打の歩', () => false),
  technique('継ぎ歩', () => false),
  technique('歩切れ', (move, before, after) => {
    if (!isDrop(move) || move.pieceType !== PieceType.PAWN) return false
    return (
      after.hand(move.color).count(PieceType.PAWN) === 0 &&
      before.hand(move.color).count(PieceType.PAWN) >= 1
    )
  }),

  technique('桂頭の桂', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.KNIGHT) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.KNIGHT
  }),
  technique('桂頭の銀', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.SILVER) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.KNIGHT
  }),
  technique('桂頭の玉', (move, _before, after) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.KING) return false
    const target = front(move.to, move.color, 2)
    if (target === undefined) return false
    const piece = after.board.at(target)
    return piece !== null && piece.color === move.color && piece.type === PieceType.KNIGHT
  }),
  technique('桂頭攻め', (move, before) => {
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.KNIGHT
  }),
  technique('歩頭の桂', (move, before) => {
    if (move.pieceType !== PieceType.KNIGHT) return false
    const b = back(move.to, move.color)
    if (b === undefined) return false
    const piece = before.board.at(b)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.PAWN
  }),
  technique('金頭の桂', (move, before) => {
    if (move.pieceType !== PieceType.KNIGHT) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.GOLD
  }),
  technique('高跳びの桂', (move, _before, after) =>
    move.from instanceof Square &&
    move.pieceType === PieceType.KNIGHT &&
    after.board.hasPower(move.to, reverseColor(move.color)),
  ),
  technique('急所の桂', (move, before) => {
    if (move.pieceType !== PieceType.KNIGHT) return false
    const king = before.board.findKing(reverseColor(move.color))
    return (
      king !== undefined &&
      Math.abs(move.to.file - king.file) <= 2 &&
      Math.abs(move.to.rank - king.rank) <= 2
    )
  }),
  technique('技ありの桂', (move, _before, after) =>
    move.pieceType === PieceType.KNIGHT &&
    countEnemyTargetsFrom(after, move.to, new Piece(move.color, PieceType.KNIGHT)) >= 2,
  ),
  technique('跳ね違いの桂', (move) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.KNIGHT) return false
    const forward = move.color === Color.BLACK ? -2 : 2
    if (move.to.rank - move.from.rank !== forward) return false
    return (
      (move.from.file === 2 && move.to.file === 3) ||
      (move.from.file === 8 && move.to.file === 7)
    )
  }),
  technique('三桂懐刃', (move, _before, after) => {
    if (![PieceType.KNIGHT, PieceType.PROM_KNIGHT].includes(move.pieceType)) return false
    let count = 0
    for (const square of after.board.listNonEmptySquares()) {
      const piece = after.board.at(square)
      if (
        piece !== null &&
        piece.color === move.color &&
        [PieceType.KNIGHT, PieceType.PROM_KNIGHT].includes(piece.type)
      ) {
        count += 1
      }
    }
    return count >= 3
  }),
  technique('継ぎ桂', (move, before) => {
    if (move.pieceType !== PieceType.KNIGHT) return false
    const target = front(move.to, move.color, 2)
    if (target === undefined) return false
    const piece = before.board.at(target)
    return piece !== null && piece.color === move.color && piece.type === PieceType.KNIGHT
  }),
  technique('吊るし桂', (move, before) => {
    if (!isDrop(move) || move.pieceType !== PieceType.KNIGHT) return false
    const knight = new Piece(move.color, PieceType.KNIGHT)
    for (const direction of movableDirections(knight)) {
      const square = move.to.neighbor(direction)
      if (!square.valid) continue
      const target = before.board.at(square)
      if (target !== null && target.color !== move.color && target.type === PieceType.KING) return true
    }
    return false
  }),
  technique('控えの桂', (move) =>
    isDrop(move) && move.pieceType === PieceType.KNIGHT && isInOwnCamp(move.color, move.to.rank),
  ),

  technique('頭金', (move, before) => {
    if (!GOLD_LIKE.includes(movedPieceType(move))) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const king = before.board.at(f)
    return king !== null && king.color !== move.color && king.type === PieceType.KING
  }),
  technique('頭銀', (move, before) => {
    if (move.pieceType !== PieceType.SILVER || move.promote) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const king = before.board.at(f)
    return king !== null && king.color !== move.color && king.type === PieceType.KING
  }),
  technique('腹金', (move, before) => {
    if (!GOLD_LIKE.includes(movedPieceType(move))) return false
    const king = enemyKing(move, before)
    return king !== undefined && move.to.rank === king.rank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('腹銀', (move, before) => {
    if (move.pieceType !== PieceType.SILVER || move.promote) return false
    const king = enemyKing(move, before)
    return king !== undefined && move.to.rank === king.rank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('尻金', (move, before) => {
    if (!GOLD_LIKE.includes(movedPieceType(move))) return false
    const king = enemyKing(move, before)
    if (king === undefined) return false
    return move.to.equals(back(king, reverseColor(move.color)))
  }),
  technique('尻銀', (move, before) => {
    if (move.pieceType !== PieceType.SILVER || move.promote) return false
    const king = enemyKing(move, before)
    if (king === undefined) return false
    return move.to.equals(back(king, reverseColor(move.color)))
  }),
  technique('肩金', (move, before) => {
    if (!GOLD_LIKE.includes(movedPieceType(move))) return false
    const king = enemyKing(move, before)
    if (king === undefined) return false
    const enemy = reverseColor(move.color)
    const frontRank = king.rank + (enemy === Color.BLACK ? -1 : 1)
    return move.to.rank === frontRank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('肩銀', (move, before) => {
    if (move.pieceType !== PieceType.SILVER || move.promote) return false
    const king = enemyKing(move, before)
    if (king === undefined) return false
    const enemy = reverseColor(move.color)
    const frontRank = king.rank + (enemy === Color.BLACK ? -1 : 1)
    return move.to.rank === frontRank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('裾金', (move, before) => {
    if (!GOLD_LIKE.includes(movedPieceType(move))) return false
    const king = enemyKing(move, before)
    if (king === undefined) return false
    const enemy = reverseColor(move.color)
    const backRank = king.rank + (enemy === Color.BLACK ? 1 : -1)
    return move.to.rank === backRank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('裾銀', (move, before) => {
    if (move.pieceType !== PieceType.SILVER || move.promote) return false
    const king = enemyKing(move, before)
    if (king === undefined) return false
    const enemy = reverseColor(move.color)
    const backRank = king.rank + (enemy === Color.BLACK ? 1 : -1)
    return move.to.rank === backRank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('こびん攻め', (move, before) => {
    const king = enemyKing(move, before)
    if (king === undefined) return false
    const enemy = reverseColor(move.color)
    const frontRank = king.rank + (enemy === Color.BLACK ? -1 : 1)
    return move.to.rank === frontRank && Math.abs(move.to.file - king.file) === 1
  }),
  technique('玉頭攻め', (move, before) => {
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && piece.type === PieceType.KING
  }),
  technique('玉頭戦', (move, before) => {
    const king = enemyKing(move, before)
    if (king === undefined) return false
    if (Math.abs(move.to.file - king.file) > 2 || Math.abs(move.to.rank - king.rank) > 2) return false
    const enemy = reverseColor(move.color)
    const frontSide = enemy === Color.BLACK ? -1 : 1
    return (move.to.rank - king.rank) * frontSide > 0
  }),
  technique('角頭攻め', (move, before) => {
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const piece = before.board.at(f)
    return piece !== null && piece.color !== move.color && BISHOP_LIKE.includes(piece.type)
  }),
  technique('雪隠詰め', (move, _before, after) => {
    const enemy = reverseColor(move.color)
    if (!after.board.isChecked(enemy)) return false
    const king = after.board.findKing(enemy)
    return king !== undefined && [1, 9].includes(king.file) && [1, 9].includes(king.rank)
  }),
  technique('都詰め', (move, _before, after) => {
    const enemy = reverseColor(move.color)
    if (!after.board.isChecked(enemy)) return false
    const king = after.board.findKing(enemy)
    return king !== undefined && king.file === 5 && king.rank === 5
  }),
  technique('王手飛車', checkAndTarget(true, ROOK_LIKE)),
  technique('王手角', checkAndTarget(true, BISHOP_LIKE)),
  technique('準王手飛車', checkAndTarget(false, ROOK_LIKE)),
  technique('準王手角', checkAndTarget(false, BISHOP_LIKE)),

  technique(
    '割り打ちの銀',
    (move, _before, after) =>
      isDrop(move) &&
      move.pieceType === PieceType.SILVER &&
      countEnemyTargetsFrom(after, move.to, new Piece(move.color, PieceType.SILVER)) >= 2,
    ['割打ちの銀'],
  ),
  technique('ふんどしの桂', (move, _before, after) =>
    isDrop(move) &&
    move.pieceType === PieceType.KNIGHT &&
    countEnemyTargetsFrom(after, move.to, new Piece(move.color, PieceType.KNIGHT)) >= 2,
  ),
  technique('両取り', (move, _before, after) =>
    countEnemyTargetsFrom(after, move.to, new Piece(move.color, movedPieceType(move))) >= 2,
  ),
  technique('角による両取り', (move, _before, after) => {
    const pieceType = movedPieceType(move)
    return (
      BISHOP_LIKE.includes(pieceType) &&
      countEnemyTargetsFrom(after, move.to, new Piece(move.color, pieceType)) >= 2
    )
  }),
  technique('飛車による両取り', (move, _before, after) => {
    const pieceType = movedPieceType(move)
    return (
      ROOK_LIKE.includes(pieceType) &&
      countEnemyTargetsFrom(after, move.to, new Piece(move.color, pieceType)) >= 2
    )
  }),
  technique('卓上の銀', (move) =>
    isDrop(move) &&
    move.pieceType === PieceType.SILVER &&
    move.to.file >= 4 &&
    move.to.file <= 6 &&
    move.to.rank >= 4 &&
    move.to.rank <= 6,
  ),
  technique('田楽刺し', (move, _before, after) => {
    const pieceType = movedPieceType(move)
    if (![PieceType.LANCE, PieceType.ROOK, PieceType.DRAGON].includes(pieceType)) return false
    let captured = 0
    let square = front(move.to, move.color)
    let step = 0
    while (square?.valid) {
      step += 1
      const piece = after.board.at(square)
      if (piece !== null) {
        if (piece.color === move.color) break
        captured += 1
        if (captured >= 2) return true
      }
      square = front(square, move.color)
      if (step > 8) break
    }
    return false
  }),
  technique('自陣飛車', (move) =>
    isDrop(move) && move.pieceType === PieceType.ROOK && isInOwnCamp(move.color, move.to.rank),
  ),
  technique('自陣角', (move) =>
    isDrop(move) && move.pieceType === PieceType.BISHOP && isInOwnCamp(move.color, move.to.rank),
  ),
  technique('遠見の角', (move) =>
    isDrop(move) &&
    move.pieceType === PieceType.BISHOP &&
    move.to.rank === (move.color === Color.BLACK ? 9 : 1),
  ),
  technique('二枚飛車', (move, before) => {
    if (!isDrop(move) || !ROOK_LIKE.includes(move.pieceType)) return false
    return before.board.listNonEmptySquares().some((square) => {
      const piece = before.board.at(square)
      return piece !== null && piece.color === move.color && ROOK_LIKE.includes(piece.type)
    })
  }),

  technique(
    '端攻め',
    (move) => [1, 9].includes(move.to.file) && !isInOwnCamp(move.color, move.to.rank),
    ['端攻撃'],
  ),
  technique('端玉', (move) => move.pieceType === PieceType.KING && [1, 9].includes(move.to.file)),
  technique('銀不成', narazu(PieceType.SILVER)),
  technique('角不成', narazu(PieceType.BISHOP)),
  technique('飛車不成', narazu(PieceType.ROOK)),
  technique('角交換', (move) =>
    BISHOP_LIKE.includes(move.pieceType) &&
    move.capturedPieceType !== null &&
    BISHOP_LIKE.includes(move.capturedPieceType),
  ),
  technique('飛車先交換', (move) =>
    move.from instanceof Square &&
    move.pieceType === PieceType.PAWN &&
    move.capturedPieceType === PieceType.PAWN &&
    move.to.file === (move.color === Color.BLACK ? 2 : 8),
  ),
  technique('角切り', giri(BISHOP_LIKE)),
  technique('飛車切り', giri(ROOK_LIKE)),
  technique('馬切り', giri([PieceType.HORSE])),
  technique('竜切り', giri([PieceType.DRAGON])),
  technique('角には角', matchup(BISHOP_LIKE, PieceType.BISHOP)),
  technique('角には飛車', matchup(ROOK_LIKE, PieceType.BISHOP)),
  technique('飛車には角', matchup(BISHOP_LIKE, PieceType.ROOK)),
  technique('飛車には飛車', matchup(ROOK_LIKE, PieceType.ROOK)),
  technique('馬には角', matchup(BISHOP_LIKE, PieceType.HORSE)),
  technique('馬には飛車', matchup(ROOK_LIKE, PieceType.HORSE)),
  technique('龍には角', matchup(BISHOP_LIKE, PieceType.DRAGON)),
  technique('龍には飛車', matchup(ROOK_LIKE, PieceType.DRAGON)),

  technique('入玉', (move) => {
    if (move.pieceType !== PieceType.KING || !isInPromotionZone(move.color, move.to.rank)) return false
    return !(move.from instanceof Square) || !isInPromotionZone(move.color, move.from.rank)
  }),
  technique('浮き飛車', (move) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.ROOK) return false
    return move.color === Color.BLACK
      ? move.from.rank === 8 && move.to.rank === 6
      : move.from.rank === 2 && move.to.rank === 4
  }),
  technique('中段玉', (move) => move.pieceType === PieceType.KING && move.to.rank === 5),
  technique('玉単騎', (move, _before, after) => {
    if (move.pieceType !== PieceType.KING) return false
    for (const direction of directions) {
      const square = move.to.neighbor(direction)
      if (!square.valid) continue
      const piece = after.board.at(square)
      if (piece !== null && piece.color === move.color) return false
    }
    return true
  }),
  technique('玉飛接近', (move, _before, after) => {
    if (![PieceType.KING, PieceType.ROOK, PieceType.DRAGON].includes(move.pieceType)) return false
    const king = after.board.findKing(move.color)
    if (king === undefined) return false
    for (const square of after.board.listNonEmptySquares()) {
      const piece = after.board.at(square)
      if (
        piece !== null &&
        piece.color === move.color &&
        ROOK_LIKE.includes(piece.type) &&
        Math.abs(square.file - king.file) <= 2 &&
        Math.abs(square.rank - king.rank) <= 2
      ) {
        return true
      }
    }
    return false
  }),
  technique('守りの馬', (move) =>
    move.from instanceof Square &&
    movedPieceType(move) === PieceType.HORSE &&
    isInOwnCamp(move.color, move.to.rank),
  ),
  technique('と金攻め', (move) =>
    (move.promote && move.pieceType === PieceType.PAWN && move.from instanceof Square) ||
    move.pieceType === PieceType.PROM_PAWN,
  ),
  technique('マムシのと金', (move) =>
    move.pieceType === PieceType.PROM_PAWN && isInPromotionZone(move.color, move.to.rank),
  ),
  technique('一間竜', (move, _before, after) => {
    if (movedPieceType(move) !== PieceType.DRAGON) return false
    const king = after.board.findKing(reverseColor(move.color))
    if (king === undefined) return false
    const dx = Math.abs(move.to.file - king.file)
    const dy = Math.abs(move.to.rank - king.rank)
    return (dx === 0 && dy === 2) || (dx === 2 && dy === 0)
  }),
  technique('たすきの銀', (move) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.SILVER) return false
    if (Math.abs(move.to.file - move.from.file) !== 1 || Math.abs(move.to.rank - move.from.rank) !== 1) {
      return false
    }
    return isInOwnCamp(move.color, move.from.rank) || isInOwnCamp(move.color, move.to.rank)
  }),
  technique('たすきの角', (move) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.BISHOP) return false
    const dx = Math.abs(move.to.file - move.from.file)
    const dy = Math.abs(move.to.rank - move.from.rank)
    return dx === dy && dx >= 2
  }),
  technique('銀ばさみ', (move, before) => {
    if (move.pieceType !== PieceType.PAWN) return false
    const f = front(move.to, move.color)
    if (f === undefined) return false
    const silver = before.board.at(f)
    if (silver === null || silver.color === move.color || silver.type !== PieceType.SILVER) return false
    const f2 = front(move.to, move.color, 2)
    if (f2 === undefined) return false
    const piece = before.board.at(f2)
    return piece !== null && piece.color === move.color
  }),
  technique('パンティを脱ぐ', (move) => {
    if (!(move.from instanceof Square) || move.pieceType !== PieceType.GOLD) return false
    return move.color === Color.BLACK
      ? [4, 5].includes(move.from.file) && move.from.rank === 9 && move.to.rank === 8
      : [5, 6].includes(move.from.file) && move.from.rank === 1 && move.to.rank === 2
  }),
  technique('角合い', (move, before) =>
    isDrop(move) && move.pieceType === PieceType.BISHOP && before.board.isChecked(move.color),
  ),
  technique('駒柱', (move, _before, after) => {
    for (let rank = 1; rank <= 9; rank += 1) {
      if (after.board.at(new Square(move.to.file, rank)) === null) return false
    }
    return true
  }),

  technique('焦点の歩', (move, before) =>
    isDrop(move) &&
    move.pieceType === PieceType.PAWN &&
    countPowerSources(before, move.to, reverseColor(move.color)) >= 2,
  ),
  technique('開き王手', (move, _before, after) => {
    if (!(move.from instanceof Square)) return false
    const opponent = reverseColor(move.color)
    const king = after.board.findKing(opponent)
    if (king === undefined || !after.board.isChecked(opponent)) return false
    const sources = countPowerSources(after, king, move.color)
    const movedPieceChecks = pieceAttacksSquare(after, move.to, king)
    return sources >= (movedPieceChecks ? 2 : 1)
  }),
  technique('両王手', (move, _before, after) => {
    const opponent = reverseColor(move.color)
    const king = after.board.findKing(opponent)
    return king !== undefined && countPowerSources(after, king, move.color) >= 2
  }),
  technique('逆王手', (move, before, after) =>
    before.board.isChecked(move.color) && after.board.isChecked(reverseColor(move.color)),
  ),
  technique('成り捨て', (move, _before, after) =>
    move.from instanceof Square &&
    move.promote &&
    move.capturedPieceType === null &&
    after.board.hasPower(move.to, reverseColor(move.color)),
  ),
  technique('十字飛車', (move, _before, after) => {
    const piece = after.board.at(move.to)
    if (piece === null || piece.color !== move.color || !ROOK_LIKE.includes(piece.type)) return false
    const vertical =
      rayHasEnemy(after, move.to, Direction.UP, move.color) ||
      rayHasEnemy(after, move.to, Direction.DOWN, move.color)
    const horizontal =
      rayHasEnemy(after, move.to, Direction.LEFT, move.color) ||
      rayHasEnemy(after, move.to, Direction.RIGHT, move.color)
    return vertical && horizontal
  }),
  technique('合駒請求', (move, _before, after) => {
    const opponent = reverseColor(move.color)
    return longChecks(after, opponent).some(
      ({ checker, between }) => checker.equals(move.to) && between.length > 0,
    )
  }),
  technique('移動合い', (move, before, after) => {
    if (!(move.from instanceof Square) || move.pieceType === PieceType.KING) return false
    if (move.capturedPieceType !== null) return false
    if (!before.board.isChecked(move.color) || after.board.isChecked(move.color)) return false
    return longChecks(before, move.color).some(({ between }) =>
      between.some((square) => square.equals(move.to)),
    )
  }),
  technique('中合い', (move, before, after) => {
    if (!isDrop(move)) return false
    if (!before.board.isChecked(move.color) || after.board.isChecked(move.color)) return false
    for (const { between } of longChecks(before, move.color)) {
      if (
        between.some((square) => square.equals(move.to)) &&
        between.length > 0 &&
        !move.to.equals(between[0])
      ) {
        return true
      }
    }
    return false
  }),
]

export function detectTechniquesAtMove(
  move: Move,
  before: ImmutablePosition,
  after: ImmutablePosition,
): TechniqueTemplate[] {
  return KNOWN_TECHNIQUES.filter((template) => template.matches(move, before, after))
}

/** 棋譜全体を走査し、各手で発動した手筋をすべて返す。 */
export function recordTechniques(
  moves: readonly Move[],
  initial?: Position,
): DetectedTechnique[] {
  const position = (initial ?? new Position()).clone()
  const results: DetectedTechnique[] = []
  for (const [index, move] of moves.entries()) {
    const before = position.clone()
    position.doMove(move, { ignoreValidation: true })
    for (const template of detectTechniquesAtMove(move, before, position)) {
      results.push({ template, ply: index + 1, color: move.color })
    }
  }
  return results
}

/** 同じ (手筋名, 陣営) は最初の1回だけ返す。 */
export function recordTechniquesFirstOccurrence(
  moves: readonly Move[],
  initial?: Position,
): DetectedTechnique[] {
  const seen = new Set<string>()
  return recordTechniques(moves, initial).filter((hit) => {
    const key = `${hit.template.name}|${hit.color}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
