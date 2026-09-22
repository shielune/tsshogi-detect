/**
 * 指し手列の走査。各定義が**初めて成立した手**を拾う。
 *
 * 照合そのものは match.ts、系統の扱いは hierarchy.ts に置いてある。ここが見るのは
 * 「どの局面でどの定義を照らすか」と「1 度きりにする」ところだけ。
 */

import { Color, type Move, Position } from 'tsshogi'
import { dropUnestablishedChildren } from './hierarchy.ts'
import {
  detectDefinitions,
  hasBishopExchangeConstraint,
  hasDropConstraint,
  hasFinishConstraint,
  hasHistoryRequirement,
  hasPlyConstraint,
  matchesFinishMove,
  matchesDefinition,
  satisfiesPlyConstraint,
} from './match.ts'
import { MoveHistory } from './move-history.ts'
import { orderDetectionsWithinPly } from './order.ts'
import type { DetectedDefinitionAt, FormationDefinition } from './definition.ts'

const SIDES: readonly Color[] = [Color.BLACK, Color.WHITE]

export type RecordDefinitionsOptions = {
  /** 初期局面。省略時は平手。 */
  readonly initial?: Position
  /**
   * 成立を認めるのを**指した側だけ**にする。既定は両陣営 (囲い検出の元の挙動)。
   *
   * 囲い・戦法は指した側で成立するものなので、相手の手で条件が満たされても
   * その陣営の成立は次に自分が指すまで待たせたい、というときに立てる。これが無いと
   * `2手目△7四歩戦法` (plyEq: 2) のような手数指定定義が、1 手目に同じ形を
   * 作った相手側にも付く。
   */
  readonly moverOnly?: boolean
  /**
   * 親が成立していない子の成立を落とす (dropUnestablishedChildren)。既定は落とさない。
   *
   * 走査そのものは全定義独立に回して、最後に系統でふるいをかける。
   */
  readonly requireParent?: boolean
  /**
   * game-end 評価定義 (居玉) を、他の定義が成立済みの陣営には出さない。
   * 囲い (recordCastles) の挙動。戦法は抑制しない (Dart 版と同じ)。
   */
  readonly suppressGameEndIfDetected?: boolean
}

/**
 * 指し手列を走査し、各定義が初めて成立した手だけを ply 順に返す。
 *
 * - ply 0 (初期局面) は対象外
 * - 同じ (定義名, 陣営) は最初の 1 回だけ
 * - game-end 評価定義は走査後に 1 度だけ評価し、開戦手数 (outbreakTurn) が
 *   あればその手数で記録する。玉が動いていないという状態の評価なので、ここだけは
 *   `moverOnly` の制限を受けない
 */
export function recordDefinitions(
  definitions: readonly FormationDefinition[],
  moves: readonly Move[],
  options?: RecordDefinitionsOptions,
): DetectedDefinitionAt[] {
  return sift(scanDefinitions(definitions, moves, options), definitions, options)
}

/**
 * `recordDefinitions` と同じ走査に、系統のふるいで落ちた検出を添えて返す。
 *
 * 落ちた件数を数えるためだけのもの (系譜図の「親が成立せずに落ちた実績」)。
 * ふるいを通していない生の検出を単体で外へ出さないよう、必ず対で返す。
 */
export function recordDefinitionsWithDropped(
  definitions: readonly FormationDefinition[],
  moves: readonly Move[],
  options?: RecordDefinitionsOptions,
): { readonly detections: DetectedDefinitionAt[]; readonly dropped: DetectedDefinitionAt[] } {
  const scanned = scanDefinitions(definitions, moves, options)
  const detections = sift(scanned, definitions, options)
  const kept = new Set(detections.map((detected) => `${detected.definition.name}|${detected.side}`))
  return {
    detections,
    dropped: scanned.filter((detected) => !kept.has(`${detected.definition.name}|${detected.side}`)),
  }
}

/**
 * 走査の後始末。親ゲートでふるってから、同じ手数の中を並べ替える。
 */
function sift(
  scanned: readonly DetectedDefinitionAt[],
  definitions: readonly FormationDefinition[],
  options?: RecordDefinitionsOptions,
): DetectedDefinitionAt[] {
  const gated =
    options?.requireParent === true ? dropUnestablishedChildren(scanned, definitions) : [...scanned]
  // 並べ替えは同じ手数の固まりの中だけ。固まりの位置は動かさないので、
  // 手数の昇順から外れている末尾の居玉も今の場所に残る。
  return orderDetectionsWithinPly(gated, definitions)
}

/** 走査本体。系統のふるいは通していないので、外に出すのは上の 2 つだけ。 */
function scanDefinitions(
  definitions: readonly FormationDefinition[],
  moves: readonly Move[],
  options?: RecordDefinitionsOptions,
): DetectedDefinitionAt[] {
  const position = (options?.initial ?? new Position()).clone()
  const history = new MoveHistory()
  history.initFromPosition(position)

  const results: DetectedDefinitionAt[] = []
  const seen = new Set<string>()
  const gameEndDefinitions = definitions.filter((definition) => definition.evaluateAtGameEnd === true)
  // カテゴリは走査では成立しないので、打ち切りの目標数から外す (外さないと届かなくなる)
  const scannable = definitions.filter((definition) => definition.category !== true).length

  const emit = (definition: FormationDefinition, side: Color, ply: number): void => {
    const key = `${definition.name}|${side}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ definition, side, ply })
  }

  const emitAt = (ply: number, move: Move): void => {
    const mover = move.color
    const moverOnly = options?.moverOnly === true
    const sides = moverOnly ? [mover] : SIDES
    // 両陣営のときは side を渡さない (定義毎に先手・後手と並ぶ元の順序を保つ)
    for (const detected of detectDefinitions(definitions, position, moverOnly ? mover : undefined)) {
      emit(detected.definition, detected.side, ply)
    }
    for (const definition of definitions) {
      if (definition.evaluateAtGameEnd === true || definition.category === true) continue
      // ply 制約も履歴要件も打ち・最終手・角交換の制約も無いものは detectDefinitions が拾い済み
      if (
        !hasPlyConstraint(definition) &&
        !hasHistoryRequirement(definition) &&
        !hasDropConstraint(definition) &&
        !hasFinishConstraint(definition) &&
        !hasBishopExchangeConstraint(definition)
      ) {
        continue
      }
      if (hasPlyConstraint(definition) && !satisfiesPlyConstraint(definition, ply)) continue
      // 最終手を縛る定義は、その手を指した側にしか成立しようが無い
      for (const side of hasFinishConstraint(definition) ? [mover] : sides) {
        if (!matchesFinishMove(definition, side, move)) continue
        if (!matchesDefinition(position, definition, side, history)) continue
        emit(definition, side, ply)
      }
    }
  }

  for (const [index, move] of moves.entries()) {
    const ply = index + 1
    // 履歴は doMove の前に記録する。PieceUnmoved が「動かす直前の from」を見るため。
    history.recordMove(move, ply)
    position.doMove(move, { ignoreValidation: true })
    // 駒落ちなら 1 手目が後手なので、手番は ply の偶奇ではなく指し手から取る
    emitAt(ply, move)
    // 全定義が両陣営で見つかったら以降の走査に意味は無い
    if (gameEndDefinitions.length === 0 && seen.size === scannable * 2) return results
  }
  if (moves.length === 0) return results

  // game-end フェーズ。抑制オプション時は、既に定義検出済みの陣営へは出さない
  const detectedSides = new Set(results.map((detected) => detected.side))
  for (const definition of gameEndDefinitions) {
    for (const side of SIDES) {
      if (options?.suppressGameEndIfDetected === true && detectedSides.has(side)) continue
      if (!matchesDefinition(position, definition, side, history)) continue
      // 居玉は「戦いが起きた時点で玉が動いていない」状態なので、戦端の手数で出す
      emit(definition, side, history.outbreakTurn ?? moves.length)
    }
  }
  return results
}

/** USI 指し手列から tsshogi の Move 列を起こす。不正な手に当たったら打ち切る。 */
export function buildMoves(usis: readonly string[], initial?: Position): Move[] {
  const position = (initial ?? new Position()).clone()
  const moves: Move[] = []
  for (const usi of usis) {
    const move = position.createMoveByUSI(usi)
    if (move === null || !position.doMove(move)) return moves
    moves.push(move)
  }
  return moves
}
