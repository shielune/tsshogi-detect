/**
 * 検出結果の並び順 (`priority:`)。
 *
 * 同じ手数でいくつも成立したときに、読む側が「こちらを代表として扱いたい」と
 * 思う順に並べるためのもの。**落とす数は変えない** — 成立したものは今までどおり
 * 全部返し、配列の順番だけを変える。
 */

import type { DetectedTemplate, DetectedTemplateAt, FormationTemplate } from './template.ts'

/** テンプレの優先度。書いていなければ 0。大きいほど前に出る。 */
export function priorityOf(template: FormationTemplate): number {
  return template.priority ?? 0
}

/** 優先度の降順。同位は 0 を返すので、Array#sort の安定性で元の順が残る。 */
const descending = (a: DetectedTemplate, b: DetectedTemplate): number =>
  priorityOf(b.template) - priorityOf(a.template)

/** 優先度を書いたテンプレが 1 つも無ければ、並べ替えそのものを省く。 */
const untouched = (detections: readonly DetectedTemplate[]): boolean =>
  detections.every((detected) => priorityOf(detected.template) === 0)

/**
 * 配列全体を優先度の降順に並べ替える。手数を持たない検出 (局面 1 枚) 用。
 */
export function sortByPriority<T extends DetectedTemplate>(detections: readonly T[]): T[] {
  if (untouched(detections)) return [...detections]
  return [...detections].sort(descending)
}

/**
 * **隣り合った同じ手数の固まりの中だけ**を優先度の降順に並べ替える。
 *
 * 固まりの位置そのものは動かさない。走査の結果は必ずしも手数の昇順に一列では
 * なく (囲いは居玉 1 件が末尾に積まれる)、全体を手数で並べ替え直すと優先度とは
 * 関係のない移動が混ざるため。同じ手数で隣り合っている組は `emitAt` が 1 手ぶんを
 * まとめて積んだものなので、これがそのまま「同時に成立した組」になる。
 */
export function sortByPriorityWithinPly(detections: readonly DetectedTemplateAt[]): DetectedTemplateAt[] {
  if (untouched(detections)) return [...detections]
  const sorted: DetectedTemplateAt[] = []
  for (let start = 0; start < detections.length; ) {
    let end = start + 1
    while (end < detections.length && detections[end].ply === detections[start].ply) end += 1
    sorted.push(...detections.slice(start, end).sort(descending))
    start = end
  }
  return sorted
}
