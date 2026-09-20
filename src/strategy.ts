/**
 * 戦法検出。囲い (castle.ts) と同じ照合・走査を、戦法という母集団に当てて呼ぶ層。
 *
 * 囲いとの違いは走査の細目だけで、テンプレートの形も照合の規則も共通:
 * - 成立を認めるのは指した側だけ (`moverOnly`)。相手の手で形が揃っても、その陣営の
 *   成立はその陣営が次に指すまで待つ。これが無いと `2手目△7四歩戦法` のような
 *   手数指定の戦法が、1 手目に同じ形を作った相手側にも付く
 * - 親が成立していない子は落とす (`requireParent`)。「三間飛車」が立たないのに
 *   その子だけが付く、という読めない結果を避ける
 * - 居玉のような game-end 評価テンプレは抑制しない (囲いだけの都合)
 *
 * データは strategies.gen.ts に切り出してある。
 */

import type { Color, ImmutablePosition, Move, Position } from 'tsshogi'
import { detectTemplates } from './match.ts'
import type { MoveHistory } from './move-history.ts'
import { recordTemplates } from './scan.ts'
import { KNOWN_STRATEGIES } from './strategies.gen.ts'
import type { DetectedTemplate, DetectedTemplateAt, FormationTemplate } from './template.ts'

/**
 * 戦法テンプレート。中身は `FormationTemplate` (囲いと戦法で同じ形) と同じもの。
 */
export type StrategyTemplate = FormationTemplate

export type DetectedStrategy = DetectedTemplate

export type DetectedStrategyAt = DetectedTemplateAt

export { KNOWN_STRATEGIES }

export function findStrategy(name: string): StrategyTemplate | undefined {
  return KNOWN_STRATEGIES.find((t) => t.name === name || (t.aliases ?? []).includes(name))
}

/**
 * 局面だけから戦法を検出する。side を省略すると両陣営。
 *
 * ply 制約付きと game-end 評価のテンプレは局面だけでは検証できないので飛ばす。
 * 「初めて成立した手」が要るなら recordStrategies を使う。
 */
export function detectStrategies(
  position: ImmutablePosition,
  side?: Color,
  history?: MoveHistory,
): DetectedStrategy[] {
  return detectTemplates(KNOWN_STRATEGIES, position, side, history)
}

/**
 * 指し手列を走査し、各戦法が初めて成立した手だけを ply 順に返す。
 *
 * - ply 0 (初期局面) は対象外
 * - 同じ (戦法名, 陣営) は最初の 1 回だけ
 * - 成立を認めるのは指した側だけ、かつ親が成立していない子は落とす
 */
export function recordStrategies(
  moves: readonly Move[],
  initial?: Position,
): DetectedStrategyAt[] {
  return recordTemplates(KNOWN_STRATEGIES, moves, {
    initial,
    moverOnly: true,
    requireParent: true,
  })
}
