// 定義 DSL の `finish:` ヘッダ (成立を認める最終手) の解析。parser.ts の分割の一部。

import { isDigits, type ParsedFinishMove, DefinitionSyntaxError } from './parser-types.ts'
import { tryParseCellToken } from './parser-cell-token.ts'
import type { DefinitionFinishCapture, DefinitionSquare } from './definition.ts'

/** 書式の説明。移動元あり・なしの両方を出す (どちらで書いても良い)。 */
function finishSyntaxError(value: string, lineNo: number): DefinitionSyntaxError {
  return new DefinitionSyntaxError(
    `expected "finish: <file> <rank>" or "finish: <file> <rank> > <file> <rank>" (optionally " +", " 打" and " x <piece>"), got "${value}"`,
    lineNo,
  )
}

/** 打ちに書けないものを書いた行。何と混ぜられないのかまで出す。 */
function dropSyntaxError(value: string, lineNo: number): DefinitionSyntaxError {
  return new DefinitionSyntaxError(
    `"打" takes no from square, "+" or "x" (a dropped piece has no origin, cannot promote and captures nothing) in "finish: ${value}"`,
    lineNo,
  )
}

/**
 * `x` の右側 — その手で取った駒。`*` は何か取る、`_` は取らない、駒トークンはその駒。
 *
 * 取られるのは相手の駒しかないので、`R` と `r` はどちらも同じ意味に落ちる
 * (セルトークンと違って大文字小文字で先後を書き分けない)。
 */
/**
 * `x` の右の取った駒。升のトークンと同じ書き方で読む (`*` 何か / `_` 取らない /
 * `R` その駒 / `[BR]` そのどれか / `[!BR]` それ以外の何か)。
 *
 * 取られる駒は必ず相手の駒なので、先後は書き分けない — 小文字 (`x +p`) も
 * 大文字と同じ意味で受ける (升では相手駒の印だが、ここでは区別する相手が居ない)。
 */
function parseFinishCapture(text: string, value: string, lineNo: number): DefinitionFinishCapture {
  const token = text.trim()
  const parsed = token === '' ? null : tryParseCellToken(token)
  if (parsed === null) throw finishSyntaxError(value, lineNo)
  switch (parsed.kind) {
    case 'anyPiece':
      return { kind: 'any' }
    case 'empty':
      return { kind: 'none' }
    case 'exact':
    case 'anyOf':
    case 'opponent':
      return { kind: 'pieces', pieces: parsed.pieceTypes, negated: false }
    case 'notOf':
      return { kind: 'pieces', pieces: parsed.pieceTypes, negated: true }
    default:
      throw finishSyntaxError(value, lineNo)
  }
}

/** `3 8` を升に。value は行全体で、エラー文に出すためだけに連れて回る。 */
function parseFinishSquare(text: string, value: string, lineNo: number): DefinitionSquare {
  const [fileToken, rankToken, ...rest] = text.split(/\s+/).filter((token) => token !== '')
  if (rest.length > 0 || !isDigits(fileToken) || !isDigits(rankToken)) {
    throw finishSyntaxError(value, lineNo)
  }
  const file = Number(fileToken)
  const rank = Number(rankToken)
  if (file < 1 || file > 9 || rank < 1 || rank > 9) {
    throw new DefinitionSyntaxError(`invalid coordinates in "finish: ${value}"`, lineNo)
  }
  return { file, rank }
}

/**
 * `7 7 > 7 6` (移動元あり) / `3 8` (着地升だけ) / `2 4 x P` (取った駒つき) /
 * `8 8 > 3 3 +` (成った手だけ) / `3 3 打` (打った手だけ)。
 *
 * `+` と `打` は着地升の右に付く (取った駒の `x` より前)。`+` を書かなければ成/不成は
 * 問わない。`打` を書かなければ打ちも盤上の手も当たる。
 *
 * `打` は他の印と混ぜられない — 打った駒は移動元を持たず、成れず、何も取らない。
 */
function parseFinishMove(part: string, value: string, lineNo: number): ParsedFinishMove {
  // 升は数字だけなので `x` は取った駒の前にしか出てこない
  const [squares, captured, ...rest] = part.split('x')
  if (squares === undefined || rest.length > 0) throw finishSyntaxError(value, lineNo)
  const capture = captured === undefined ? null : parseFinishCapture(captured, value, lineNo)
  const drop = squares.trimEnd().endsWith('打')
  const marked = drop ? squares.trimEnd().slice(0, -1) : squares
  const promote = marked.trimEnd().endsWith('+')
  const [origin, destination, ...extra] = (promote ? marked.trimEnd().slice(0, -1) : marked).split(
    '>',
  )
  if (origin === undefined || extra.length > 0) throw finishSyntaxError(value, lineNo)
  if (drop && (promote || capture !== null || destination !== undefined)) {
    throw dropSyntaxError(value, lineNo)
  }
  // `>` が無ければ左辺が着地升そのもの。移動元は書かれていない
  if (destination === undefined) {
    return { from: null, to: parseFinishSquare(origin, value, lineNo), capture, promote, drop }
  }
  return {
    from: parseFinishSquare(origin, value, lineNo),
    to: parseFinishSquare(destination, value, lineNo),
    capture,
    promote,
    drop,
  }
}

/**
 * `finish: 3 8` / `finish: 7 7 > 7 6` / `finish: 3 8, 2 8` — 成立を認める最終手の並び。
 *
 * `>` の左が移動元で、書かなければ移動元は問わない (着地升だけを縛る)。
 * 着地升の右の `+` は「成った手だけ」(`finish: 8 8 > 3 3 +`)。書かなければ成/不成を問わない。
 * 着地升の右の `打` は「打った手だけ」(`finish: 3 3 打`)。書かなければ打ちも盤上の手も当たる。
 * `x` の右は取った駒 (`x P` その駒 / `x [BR]` そのどれか / `x [!BR]` それ以外の何か /
 * `x *` 何か / `x _` 取らない)。書かなければ問わない。
 * 複数書いたら「そのどれか」(最終手は 1 つしか無いので AND にはしない)。
 */
export function parseFinishHeader(value: string, lineNo: number): ParsedFinishMove[] {
  const moves: ParsedFinishMove[] = []
  for (const part of value.split(',')) {
    if (part.trim() === '') continue
    moves.push(parseFinishMove(part, value, lineNo))
  }
  if (moves.length === 0) throw finishSyntaxError(value, lineNo)
  return moves
}
