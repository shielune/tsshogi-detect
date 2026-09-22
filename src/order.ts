/**
 * 検出結果の並び順。
 *
 * 同じ手で 2 つ以上成立したときに、読む側が「こちらを代表として扱いたい」と思う順に
 * 並べる。**落とす数は変えない** — 成立したものは今までどおり全部返し、配列の順番だけ
 * を変える。
 *
 * 見る順は次のとおりで、前の段で差が付いたらそこで決まる。
 *
 * 1. 優先度 (`priority:`)。大きいほど前。書いていなければ 0
 * 2. ネストの深さ。親を辿った代の数が多いほど前
 * 3. 制約の厳しさ。要件の数が多いほど前
 * 4. 手数。若いほど前
 * 5. 名前。文字コードの昇順
 *
 * 2 と 3 は「狭いことを言っている定義ほど代表にしたい」という同じ考えの二段構え。
 * 美濃囲いと片美濃囲いが同じ手で成立したら、親である片美濃囲いより子の美濃囲いを
 * 前に出す。系統の付いていないテンプレどうしは 2 で差が付かないので、3 の要件の数で
 * 決まる。
 */

import { ancestorDepths } from './hierarchy.ts'
import type { DetectedTemplate, DetectedTemplateAt, FormationTemplate } from './template.ts'

/** テンプレの優先度。書いていなければ 0。大きいほど前に出る。 */
export function priorityOf(template: FormationTemplate): number {
  return template.priority ?? 0
}

/**
 * 制約の厳しさ。要件の数で測る。多いほど狭い形を言っているとみなす。
 *
 * 升の要件に加えて、盤の外の条件 (手数・最終手・駒打ち・角交換) も 1 つずつ数える。
 * 陣営の別 (`side:`) は照合の前に絞る仕掛けで、形の狭さとは別の話なので数えない。
 */
function strictnessOf(template: FormationTemplate): number {
  let count = template.placements.length
  if (template.plyEq !== undefined) count += 1
  if (template.plyMin !== undefined) count += 1
  if (template.plyMax !== undefined) count += 1
  if ((template.finishMoves?.length ?? 0) > 0) count += 1
  if (template.noDrop === true) count += 1
  if (template.bishopExchange !== undefined) count += 1
  return count
}

/**
 * 成立した手数。手数を持たない検出 (局面 1 枚) では 0 として扱う。
 *
 * `DetectedTemplate` には `ply` が無いので、読めたときだけ読む。
 */
function plyOf(detected: DetectedTemplate): number {
  return (detected as Partial<DetectedTemplateAt>).ply ?? 0
}

/**
 * 名前の比較。文字コードの昇順で、`localeCompare` は使わない
 * (実行環境の照合順に結果が左右されると、同じ棋譜から違う並びが出てしまう)。
 */
function compareName(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 上の 5 段をこの順に見る比較器を作る。深さは毎回辿らずに引く。 */
function comparator(
  depths: ReadonlyMap<FormationTemplate, number>,
): (a: DetectedTemplate, b: DetectedTemplate) => number {
  const depthOf = (detected: DetectedTemplate): number => depths.get(detected.template) ?? 0
  return (a, b) =>
    priorityOf(b.template) - priorityOf(a.template) ||
    depthOf(b) - depthOf(a) ||
    strictnessOf(b.template) - strictnessOf(a.template) ||
    plyOf(a) - plyOf(b) ||
    compareName(a.template.name, b.template.name)
}

/**
 * 配列全体を並べ替える。手数を持たない検出 (局面 1 枚) 用。
 *
 * `templates` は系統を辿るための集合。ここに親が居ないテンプレは深さ 0 として扱う。
 */
export function orderDetections<T extends DetectedTemplate>(
  detections: readonly T[],
  templates: readonly FormationTemplate[],
): T[] {
  if (detections.length < 2) return [...detections]
  return [...detections].sort(comparator(ancestorDepths(templates)))
}

/**
 * **隣り合った同じ手数の固まりの中だけ**を並べ替える。
 *
 * 固まりの位置そのものは動かさない。走査の結果は必ずしも手数の昇順に一列では
 * なく (囲いは居玉 1 件が末尾に積まれる)、全体を並べ替え直すと「同時に成立した組の
 * 中の順」とは関係のない移動が混ざるため。同じ手数で隣り合っている組は `emitAt` が
 * 1 手ぶんをまとめて積んだものなので、これがそのまま「同時に成立した組」になる。
 *
 * 固まりの中では手数が全員同じなので、決着は優先度・深さ・厳しさ・名前で付く。
 */
export function orderDetectionsWithinPly(
  detections: readonly DetectedTemplateAt[],
  templates: readonly FormationTemplate[],
): DetectedTemplateAt[] {
  if (detections.length < 2) return [...detections]
  const compare = comparator(ancestorDepths(templates))
  const ordered: DetectedTemplateAt[] = []
  for (let start = 0; start < detections.length; ) {
    // 固まりの手数は先頭で決まる。ここから同じ手数が続く間を 1 つの固まりとして見る
    const ply = detections[start]?.ply
    let end = start + 1
    while (end < detections.length && detections[end]?.ply === ply) end += 1
    ordered.push(...detections.slice(start, end).sort(compare))
    start = end
  }
  return ordered
}
