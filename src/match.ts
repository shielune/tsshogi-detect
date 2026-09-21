/**
 * 局面 1 つとテンプレートの照合。
 *
 * 要件 (placements) の AND に加えて、盤の形だけでは言えない制約をここで見る:
 * 手数 (`ply*`)・打ちの有無 (`no_drop:`)・角交換 (`bishop_exchange:`)・
 * 成立させた手そのもの (`finish:`)。後ろの 3 つは履歴か指し手が要るので、
 * 局面だけの検出 (detectTemplates) では持っているテンプレごと飛ばす。
 */

import { Color, type ImmutablePosition, type Move, type PieceType, Square } from 'tsshogi'
import type { MoveHistory } from './move-history.ts'
import { positionOnlyHistory } from './position-history.ts'
import { orderDetections } from './order.ts'
import { isHistoryRequirement, rotate } from './requirements.ts'
import type { DetectedTemplate, FormationTemplate, TemplateFinishCapture } from './template.ts'

const SIDES: readonly Color[] = [Color.BLACK, Color.WHITE]

export function hasPlyConstraint(template: FormationTemplate): boolean {
  return (
    template.plyEq !== undefined || template.plyMin !== undefined || template.plyMax !== undefined
  )
}

export function hasHistoryRequirement(template: FormationTemplate): boolean {
  return template.placements.some(isHistoryRequirement)
}

/** 打ちの有無は履歴が要る。局面だけの検出では判定しようが無い。 */
export function hasDropConstraint(template: FormationTemplate): boolean {
  return template.noDrop === true
}

/** 成立させた手そのものを見る。局面だけの検出では判定しようが無い。 */
export function hasFinishConstraint(template: FormationTemplate): boolean {
  return template.finishMoves !== undefined && template.finishMoves.length > 0
}

/** 角交換の有無も履歴頼み (交換の跡は盤にも持駒にも残らない)。 */
export function hasBishopExchangeConstraint(template: FormationTemplate): boolean {
  return template.bishopExchange !== undefined
}

export function satisfiesPlyConstraint(template: FormationTemplate, ply: number): boolean {
  if (template.plyEq !== undefined && template.plyEq !== ply) return false
  if (template.plyMin !== undefined && ply < template.plyMin) return false
  if (template.plyMax !== undefined && ply > template.plyMax) return false
  return true
}

/**
 * テンプレが要求している升のどれかに、その陣営が打った駒がそのまま乗っているか。
 *
 * 囲い・戦法は駒を動かして組むもので、持駒を打って形だけ揃えたものは終盤の
 * たまたまの一致であることが多い。見るのは**自分の駒が居ることを求めている升**だけで、
 * 空升や否定や相手駒の指定は数えない (要件側の ownPieceSquares がそれを決める)。
 */
export function usesDroppedPiece(
  template: FormationTemplate,
  side: Color,
  history: MoveHistory,
): boolean {
  return template.placements.some((req) =>
    (req.ownPieceSquares?.(side) ?? []).some((square) => history.isDropped(side, square)),
  )
}

/**
 * その手が `finish:` のどれかに当たるか。指定が無ければ常に当たる。
 *
 * 戦法は「この手を指した瞬間に成立」と言えるものが多いので、形が揃うだけでなく
 * **揃えた手**まで縛れるようにしてある。升はテンプレ視点 (先手視点) なので
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
  template: FormationTemplate,
  side: Color,
  move: Move,
): boolean {
  const moves = template.finishMoves
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
  capture: TemplateFinishCapture | undefined,
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
 * 局面とテンプレの照合。`no_drop:` と `bishop_exchange:` は履歴が要るので、
 * 履歴が無ければ成立させない (PieceUnmoved 等の履歴要件と同じ扱い)。
 *
 * `finish:` はこの関数では見ない — 指し手を持っていないので、走査側が
 * matchesFinishMove と組にして呼ぶ。
 */
export function matchesTemplate(
  position: ImmutablePosition,
  template: FormationTemplate,
  side: Color,
  history?: MoveHistory,
): boolean {
  if (!template.placements.every((req) => req.isSatisfiedBy(position, side, history))) return false
  if (template.noDrop === true) {
    if (history === undefined) return false
    if (usesDroppedPiece(template, side, history)) return false
  }
  // 仕掛けた側は判定する陣営から見て言うので、先に取ったのが自分か相手かで分ける
  if (template.bishopExchange !== undefined) {
    if (history === undefined) return false
    const initiator = history.bishopExchangeInitiator()
    if (initiator === undefined) return false
    if (template.bishopExchange === 'self' && initiator !== side) return false
    if (template.bishopExchange === 'opponent' && initiator === side) return false
  }
  return true
}

/**
 * 局面だけからテンプレを検出する。side を省略すると両陣営。
 *
 * 手数制約・game-end 評価・打ち・最終手・角交換の制約を持つテンプレは、局面 1 枚では
 * 検証できないので飛ばす。カテゴリは要件を持たない (every が必ず真になる) ので、
 * 照合に混ぜると全局面で成立してしまう — カテゴリは検出として出てこない。
 *
 * history を省くと「初期位置に居る駒は動いていない」という近似の擬似履歴を使う
 * (PositionOnlyHistory)。棋譜を走査している側は本物の履歴を渡すこと。
 */
export function detectTemplates(
  templates: readonly FormationTemplate[],
  position: ImmutablePosition,
  side?: Color,
  history: MoveHistory = positionOnlyHistory(position),
): DetectedTemplate[] {
  const results: DetectedTemplate[] = []
  for (const template of templates) {
    if (template.category === true) continue
    if (hasPlyConstraint(template) || template.evaluateAtGameEnd === true) continue
    if (hasDropConstraint(template) || hasFinishConstraint(template)) continue
    if (hasBishopExchangeConstraint(template)) continue
    for (const color of SIDES) {
      if (side !== undefined && side !== color) continue
      if (matchesTemplate(position, template, color, history)) {
        results.push({ template, side: color })
      }
    }
  }
  // 手数を持たない検出なので、並べ替えは配列全体に掛かる。
  return orderDetections(results, templates)
}
