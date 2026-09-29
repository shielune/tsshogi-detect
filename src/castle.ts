/**
 * 囲い検出 (tsshogi-dart lib/src/castle.dart の移植)。
 *
 * 定義の配置は常に先手視点で書かれていて、後手の検出では per-cell の
 * 要件が 180° 回転して照合される。データは castles.gen.ts に切り出してある。
 *
 * 照合と走査そのものは囲いに限らないので match.ts と scan.ts に移してある。
 * ここに残るのは**囲いという母集団**を当てて呼ぶだけの層。
 */

import type { Color, ImmutablePosition, Move, Position } from 'tsshogi'
import { KNOWN_CASTLES } from './castles.gen.ts'
import { detectDefinitions } from './match.ts'
import type { MoveHistory } from './move-history.ts'
import { recordDefinitions } from './scan.ts'
import type { DetectedDefinition, DetectedDefinitionAt, FormationDefinition } from './definition.ts'

export type DetectedCastle = DetectedDefinition

export type DetectedCastleAt = DetectedDefinitionAt

export { KNOWN_CASTLES }

export function findCastle(name: string): FormationDefinition | undefined {
  return KNOWN_CASTLES.find((t) => t.name === name || (t.aliases ?? []).includes(name))
}

/**
 * 局面だけから囲いを検出する。side を省略すると両陣営。
 *
 * ply 制約付きと game-end 評価の定義は局面だけでは検証できないので飛ばす。
 * 「初めて成立した手」が要るなら recordCastles を使う。
 *
 * 履歴を省くと「初期位置に居る駒は動いていない」という近似の擬似履歴を使うので、
 * 「飛車が 2八 (初期) と 6八 (現在) を通った」程度の要件は静的にも満たせる。
 */
export function detectCastles(
  position: ImmutablePosition,
  side?: Color,
  history?: MoveHistory,
): DetectedCastle[] {
  return detectDefinitions(KNOWN_CASTLES, position, side, history)
}

/**
 * 指し手列を走査し、各囲いが初めて成立した手だけを ply 順に返す。
 *
 * - ply 0 (初期局面) は対象外
 * - 同じ (定義名, 陣営) は最初の 1 回だけ
 * - 居玉のような game-end 評価定義は走査後に 1 度だけ評価し、ちゃんとした囲いが
 *   成立している陣営には出さない
 */
export function recordCastles(moves: readonly Move[], initial?: Position): DetectedCastleAt[] {
  return recordDefinitions(KNOWN_CASTLES, moves, {
    initial,
    suppressGameEndIfDetected: true,
  })
}
