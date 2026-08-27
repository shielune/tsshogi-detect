/**
 * 将棋の格言に対応する「局面パターン」判定。
 *
 * 格言は価値判断を含むものが多いので、ここでは「格言が真」「この手が好手」とは
 * 判定しない。1手 + 前後局面から機械的に確認できる関係だけを返す。
 */

import {
  Color,
  type ImmutablePosition,
  type Move,
  PieceType,
  Position,
  reverseColor,
  Square,
} from 'tsshogi'
import { type TechniqueTemplate, detectTechniquesAtMove } from './technique.ts'

export type ProverbRelation = 'follows' | 'pattern' | 'state' | 'violates'

type ProverbMatcher = (
  move: Move,
  before: ImmutablePosition,
  after: ImmutablePosition,
  techniques: readonly TechniqueTemplate[],
) => boolean

export interface ProverbPattern {
  readonly name: string
  readonly relation: ProverbRelation
  matches: ProverbMatcher
}

export interface DetectedProverb {
  readonly pattern: ProverbPattern
  readonly ply: number
  readonly color: Color
}

function proverb(name: string, relation: ProverbRelation, matches: ProverbMatcher): ProverbPattern {
  return { name, relation, matches }
}

function technique(name: string): ProverbMatcher {
  return (_move, _before, _after, techniques) => techniques.some((t) => t.name === name)
}

function leavesIgyoku(move: Move): boolean {
  if (!(move.from instanceof Square) || move.pieceType !== PieceType.KING) return false
  const start = move.color === Color.BLACK ? new Square(5, 9) : new Square(5, 1)
  return move.from.equals(start) && !move.to.equals(start)
}

function goldRetreat(move: Move): boolean {
  if (!(move.from instanceof Square) || move.pieceType !== PieceType.GOLD) return false
  const delta = move.to.rank - move.from.rank
  return move.color === Color.BLACK ? delta > 0 : delta < 0
}

function knightCheck(move: Move, _before: ImmutablePosition, after: ImmutablePosition): boolean {
  return (
    move.pieceType === PieceType.KNIGHT &&
    !move.promote &&
    after.board.isChecked(reverseColor(move.color))
  )
}

function edgePawnAgainstEdgeKing(
  move: Move,
  _before: ImmutablePosition,
  after: ImmutablePosition,
): boolean {
  if (move.pieceType !== PieceType.PAWN || ![1, 9].includes(move.to.file)) return false
  const king = after.board.findKing(reverseColor(move.color))
  return king !== undefined && king.file === move.to.file
}

export const KNOWN_PROVERBS: readonly ProverbPattern[] = [
  proverb('居玉は避けよ', 'follows', leavesIgyoku),
  proverb('金は引く手に好手あり', 'pattern', goldRetreat),
  proverb('桂の王手は合駒きかず', 'state', knightCheck),
  proverb('端玉には端歩', 'follows', edgePawnAgainstEdgeKing),
  proverb('桂は控えて打て', 'follows', technique('控えの桂')),
  proverb('下段の香に力あり', 'follows', technique('下段の香')),
  proverb('金底の歩、岩よりも堅し', 'follows', technique('金底の歩')),
  proverb('焦点の歩に好手あり', 'pattern', technique('焦点の歩')),
  proverb('飛車は十字に使え', 'follows', technique('十字飛車')),
  proverb('銀は成らずに好手あり', 'pattern', technique('銀不成')),
  proverb('角には角', 'follows', technique('角には角')),
  proverb('中段玉は寄せにくし', 'state', technique('中段玉')),
  proverb('玉飛接近すべからず', 'violates', technique('玉飛接近')),
]

export function detectProverbsAtMove(
  move: Move,
  before: ImmutablePosition,
  after: ImmutablePosition,
  techniques: readonly TechniqueTemplate[] = detectTechniquesAtMove(move, before, after),
): ProverbPattern[] {
  return KNOWN_PROVERBS.filter((pattern) => pattern.matches(move, before, after, techniques))
}

/** 棋譜全体を走査し、各手で該当した格言パターンを返す。 */
export function recordProverbs(moves: readonly Move[], initial?: Position): DetectedProverb[] {
  const position = (initial ?? new Position()).clone()
  const results: DetectedProverb[] = []
  for (const [index, move] of moves.entries()) {
    const before = position.clone()
    position.doMove(move, { ignoreValidation: true })
    const techniques = detectTechniquesAtMove(move, before, position)
    for (const pattern of detectProverbsAtMove(move, before, position, techniques)) {
      results.push({ pattern, ply: index + 1, color: move.color })
    }
  }
  return results
}
