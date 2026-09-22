/**
 * 局面 1 つと定義の照合。
 *
 * 要件 (placements) の AND に加えて、盤の形だけでは言えない制約をここで見る:
 * 手数 (`ply*`)・打ちの有無 (`no_drop:`)・角交換 (`bishop_exchange:`)・
 * 成立させた手そのもの (`finish:`)。後ろの 3 つは履歴か指し手が要るので、
 * 局面だけの検出 (detectDefinitions) では持っている定義ごと飛ばす。
 */

import { Color, type ImmutablePosition, type Move, type PieceType, Square } from 'tsshogi'
import type { MoveHistory } from './move-history.ts'
import { positionOnlyHistory } from './position-history.ts'
import { orderDetections } from './order.ts'
import { isHistoryRequirement, rotate } from './requirements.ts'
import type { DetectedDefinition, FormationDefinition, DefinitionFinishCapture } from './definition.ts'

const SIDES: readonly Color[] = [Color.BLACK, Color.WHITE]

export function hasPlyConstraint(definition: FormationDefinition): boolean {
  return (
    definition.plyEq !== undefined || definition.plyMin !== undefined || definition.plyMax !== undefined
  )
}

export function hasHistoryRequirement(definition: FormationDefinition): boolean {
  return definition.placements.some(isHistoryRequirement)
}

/** 打ちの有無は履歴が要る。局面だけの検出では判定しようが無い。 */
export function hasDropConstraint(definition: FormationDefinition): boolean {
  return definition.noDrop === true
}

/** 成立させた手そのものを見る。局面だけの検出では判定しようが無い。 */
export function hasFinishConstraint(definition: FormationDefinition): boolean {
  return definition.finishMoves !== undefined && definition.finishMoves.length > 0
}

/** 角交換の有無も履歴頼み (交換の跡は盤にも持駒にも残らない)。 */
export function hasBishopExchangeConstraint(definition: FormationDefinition): boolean {
  return definition.bishopExchange !== undefined
}

export function satisfiesPlyConstraint(definition: FormationDefinition, ply: number): boolean {
  if (definition.plyEq !== undefined && definition.plyEq !== ply) return false
  if (definition.plyMin !== undefined && ply < definition.plyMin) return false
  if (definition.plyMax !== undefined && ply > definition.plyMax) return false
  return true
}

/**
 * 定義が要求している升のどれかに、その陣営が打った駒がそのまま乗っているか。
 *
 * 囲い・戦法は駒を動かして組むもので、持駒を打って形だけ揃えたものは終盤の
 * たまたまの一致であることが多い。見るのは**自分の駒が居ることを求めている升**だけで、
 * 空升や否定や相手駒の指定は数えない (要件側の ownPieceSquares がそれを決める)。
 */
export function usesDroppedPiece(
  definition: FormationDefinition,
  side: Color,
  history: MoveHistory,
): boolean {
  return definition.placements.some((req) =>
    (req.ownPieceSquares?.(side) ?? []).some((square) => history.isDropped(side, square)),
  )
}

/**
 * その手が `finish:` のどれかに当たるか。指定が無ければ常に当たる。
 *
 * 戦法は「この手を指した瞬間に成立」と言えるものが多いので、形が揃うだけでなく
 * **揃えた手**まで縛れるようにしてある。升は定義視点 (先手視点) なので
 * 後手は 180° 回して照らす。
 *
 * `from` を書いた項目は移動元も見る。**打った手は移動元を持たない**
 * (`move.from` が Square ではなく PieceType) ので、その項目には当たらない。
 * 逆に `drop` を書いた項目は**打った手にしか当たらない**。
 *
 * `promote` を書いた項目は**成った手にしか当たらない**。盤の側は指した後の姿しか
 * 言えないので (`+B` を着地升に描いても、成った手と成駒が動いた手は区別できない)、
 * 「角が成って馬になった手」と言い切るのはこの指定だけ。
 */
export function matchesFinishMove(
  definition: FormationDefinition,
  side: Color,
  move: Move,
): boolean {
  const moves = definition.finishMoves
  if (moves === undefined || moves.length === 0) return true
  return moves.some((entry) => {
    const to = rotate(entry.to.file, entry.to.rank, side)
    if (move.to.file !== to.file || move.to.rank !== to.rank) return false
    if (!matchesCapture(entry.capture, move.capturedPieceType)) return false
    if (entry.promote === true && !move.promote) return false
    if (entry.drop === true) return !(move.from instanceof Square)
    if (entry.from === undefined) return true
    if (!(move.from instanceof Square)) return false
    const from = rotate(entry.from.file, entry.from.rank, side)
    return move.from.file === from.file && move.from.rank === from.rank
  })
}

/**
 * 取った駒の照合。指定が無ければ問わない (取っても取らなくても当たる)。
 *
 * 並べた駒は OR (最終手で取れる駒は 1 枚しか無い)。`negated` は「それ以外の何か」なので、
 * **取らなかった手には当たらない** — 何も取らない手は `none` の側で言う。
 */
function matchesCapture(
  capture: DefinitionFinishCapture | undefined,
  captured: PieceType | null,
): boolean {
  if (capture === undefined) return true
  switch (capture.kind) {
    case 'any':
      return captured !== null
    case 'none':
      return captured === null
    case 'pieces':
      return captured !== null && capture.pieces.includes(captured) !== capture.negated
  }
}

/**
 * 局面と定義の照合。`no_drop:` と `bishop_exchange:` は履歴が要るので、
 * 履歴が無ければ成立させない (PieceUnmoved 等の履歴要件と同じ扱い)。
 *
 * `finish:` はこの関数では見ない — 指し手を持っていないので、走査側が
 * matchesFinishMove と組にして呼ぶ。
 */
export function matchesDefinition(
  position: ImmutablePosition,
  definition: FormationDefinition,
  side: Color,
  history?: MoveHistory,
): boolean {
  if (!definition.placements.every((req) => req.isSatisfiedBy(position, side, history))) return false
  if (definition.noDrop === true) {
    if (history === undefined) return false
    if (usesDroppedPiece(definition, side, history)) return false
  }
  // 仕掛けた側は判定する陣営から見て言うので、先に取ったのが自分か相手かで分ける
  if (definition.bishopExchange !== undefined) {
    if (history === undefined) return false
    const initiator = history.bishopExchangeInitiator()
    if (initiator === undefined) return false
    if (definition.bishopExchange === 'self' && initiator !== side) return false
    if (definition.bishopExchange === 'opponent' && initiator === side) return false
  }
  return true
}

/**
 * 局面だけから定義を検出する。side を省略すると両陣営。
 *
 * 手数制約・game-end 評価・打ち・最終手・角交換の制約を持つ定義は、局面 1 枚では
 * 検証できないので飛ばす。カテゴリは要件を持たない (every が必ず真になる) ので、
 * 照合に混ぜると全局面で成立してしまう — カテゴリは検出として出てこない。
 *
 * history を省くと「初期位置に居る駒は動いていない」という近似の擬似履歴を使う
 * (PositionOnlyHistory)。棋譜を走査している側は本物の履歴を渡すこと。
 */
export function detectDefinitions(
  definitions: readonly FormationDefinition[],
  position: ImmutablePosition,
  side?: Color,
  history: MoveHistory = positionOnlyHistory(position),
): DetectedDefinition[] {
  const results: DetectedDefinition[] = []
  for (const definition of definitions) {
    if (definition.category === true) continue
    if (hasPlyConstraint(definition) || definition.evaluateAtGameEnd === true) continue
    if (hasDropConstraint(definition) || hasFinishConstraint(definition)) continue
    if (hasBishopExchangeConstraint(definition)) continue
    for (const color of SIDES) {
      if (side !== undefined && side !== color) continue
      if (matchesDefinition(position, definition, color, history)) {
        results.push({ definition, side: color })
      }
    }
  }
  // 手数を持たない検出なので、並べ替えは配列全体に掛かる。
  return orderDetections(results, definitions)
}
