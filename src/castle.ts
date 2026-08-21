/**
 * 囲い検出 (tsshogi-dart lib/src/castle.dart の移植)。
 *
 * テンプレートの配置は常に先手視点で書かれていて、後手の検出では per-cell の
 * 要件が 180° 回転して照合される。データは castles.gen.ts に切り出してある。
 */

import { Color, type ImmutablePosition, type Move, Position } from 'tsshogi'
import { KNOWN_CASTLES } from './castles.gen.ts'
import { MoveHistory } from './move-history.ts'
import { type CastleRequirement, isHistoryRequirement } from './requirements.ts'

export interface CastleTemplate {
  readonly name: string
  readonly placements: readonly CastleRequirement[]
  readonly aliases?: readonly string[]
  /** 親囲い (より広い分類)。親自身もテンプレートとして存在することがある。 */
  readonly parent?: string
  /** 成立手数の厳密一致制約。局面だけの検出ではこの制約を持つテンプレは飛ばす。 */
  readonly plyEq?: number
  /** 成立手数の上限。 */
  readonly plyMax?: number
  /** 最終局面で 1 度だけ評価するテンプレ (居玉)。 */
  readonly evaluateAtGameEnd?: boolean
}

export interface DetectedCastle {
  readonly template: CastleTemplate
  readonly side: Color
}

export interface DetectedCastleAt extends DetectedCastle {
  /** 初めて成立した手数。 */
  readonly ply: number
}

const SIDES: readonly Color[] = [Color.BLACK, Color.WHITE]

export { KNOWN_CASTLES }

export function findCastle(name: string): CastleTemplate | undefined {
  return KNOWN_CASTLES.find((t) => t.name === name || (t.aliases ?? []).includes(name))
}

export function hasPlyConstraint(template: CastleTemplate): boolean {
  return template.plyEq !== undefined || template.plyMax !== undefined
}

export function hasHistoryRequirement(template: CastleTemplate): boolean {
  return template.placements.some(isHistoryRequirement)
}

export function satisfiesPlyConstraint(template: CastleTemplate, ply: number): boolean {
  if (template.plyEq !== undefined && template.plyEq !== ply) return false
  if (template.plyMax !== undefined && ply > template.plyMax) return false
  return true
}

export function matchesTemplate(
  position: ImmutablePosition,
  template: CastleTemplate,
  side: Color,
  history?: MoveHistory,
): boolean {
  return template.placements.every((req) => req.isSatisfiedBy(position, side, history))
}

/**
 * 局面だけから囲いを検出する。side を省略すると両陣営。
 *
 * ply 制約付きと game-end 評価のテンプレは局面だけでは検証できないので飛ばす。
 * 「初めて成立した手」が要るなら recordCastles を使う。
 */
export function detectCastles(position: ImmutablePosition, side?: Color): DetectedCastle[] {
  // 履歴の代わりに、標準初期局面と現局面の駒位置を visited に入れた擬似履歴を渡す。
  // これで「飛車が 2八 (初期) と 6八 (現在) を通った」程度の要件は静的にも満たせる。
  const history = new MoveHistory()
  history.initFromPosition(new Position())
  history.initFromPosition(position)

  const results: DetectedCastle[] = []
  for (const template of KNOWN_CASTLES) {
    if (hasPlyConstraint(template) || template.evaluateAtGameEnd === true) continue
    for (const color of SIDES) {
      if (side !== undefined && side !== color) continue
      if (matchesTemplate(position, template, color, history)) {
        results.push({ template, side: color })
      }
    }
  }
  return results
}

/**
 * 指し手列を走査し、各囲いが初めて成立した手だけを ply 順に返す。
 *
 * - ply 0 (初期局面) は対象外
 * - 同じ (テンプレ名, 陣営) は最初の 1 回だけ
 * - 居玉のような game-end 評価テンプレは走査後に 1 度だけ評価する
 */
export function recordCastles(moves: readonly Move[], initial?: Position): DetectedCastleAt[] {
  const position = (initial ?? new Position()).clone()
  const history = new MoveHistory()
  history.initFromPosition(position)

  const results: DetectedCastleAt[] = []
  const seen = new Set<string>()

  const emitAt = (ply: number): void => {
    for (const detected of detectCastles(position)) {
      const key = `${detected.template.name}|${detected.side}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ ...detected, ply })
    }
    for (const template of KNOWN_CASTLES) {
      if (template.evaluateAtGameEnd === true) continue
      // ply 制約も履歴要件も無いものは detectCastles が拾い済み
      if (!hasPlyConstraint(template) && !hasHistoryRequirement(template)) continue
      if (hasPlyConstraint(template) && !satisfiesPlyConstraint(template, ply)) continue
      for (const side of SIDES) {
        if (!matchesTemplate(position, template, side, history)) continue
        const key = `${template.name}|${side}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ template, side, ply })
      }
    }
  }

  for (const [index, move] of moves.entries()) {
    const ply = index + 1
    // 履歴は doMove の前に記録する。PieceUnmoved が「動かす直前の from」を見るため。
    history.recordMove(move, ply)
    position.doMove(move, { ignoreValidation: true })
    emitAt(ply)
  }
  const lastPly = moves.length
  if (lastPly === 0) return results

  // game-end フェーズ。居玉は「ちゃんとした囲い」が無い陣営にだけ出す。
  const sidesWithCastle = new Set(results.map((d) => d.side))
  for (const template of KNOWN_CASTLES) {
    if (template.evaluateAtGameEnd !== true) continue
    for (const side of SIDES) {
      if (sidesWithCastle.has(side)) continue
      if (!matchesTemplate(position, template, side, history)) continue
      const key = `${template.name}|${side}`
      if (seen.has(key)) continue
      seen.add(key)
      // 居玉は「戦いが起きた時点で玉が動いていない」状態なので、戦端の手数で出す
      results.push({ template, side, ply: history.outbreakTurn ?? lastPly })
    }
  }
  return results
}
