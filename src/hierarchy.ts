/**
 * テンプレの系統 (`parent:`) を使った、走査のあとの絞り込み。
 *
 * 囲い・戦法は系統になっていて、子は親を狭めた形になっている (`美濃囲い` の親は
 * `片美濃囲い`)。ここで扱うのはその関係だけで、盤の照合には立ち入らない。
 */

import type { DetectedTemplateAt, FormationTemplate } from './template.ts'

/** 名前・別名から引く索引。親は名前で書かれ、別名で書かれていることもある。 */
function nameIndex(templates: readonly FormationTemplate[]): Map<string, FormationTemplate> {
  const index = new Map<string, FormationTemplate>()
  for (const template of templates) {
    index.set(template.name, template)
    // 別名は本名を潰さない (同じ名前が両方にあれば本名を優先)
    for (const alias of template.aliases ?? []) {
      if (!index.has(alias)) index.set(alias, template)
    }
  }
  return index
}

/** 親を辿る深さの上限。実データの最長は 5 代なので、これは循環と暴走の歯止め。 */
const MAX_ANCESTOR_DEPTH = 16

/** 索引を使い回す版。1 局に何度も辿る側 (親ゲート) はこちらを呼ぶ。 */
function ancestorChain(
  template: FormationTemplate,
  index: ReadonlyMap<string, FormationTemplate>,
): FormationTemplate[] {
  const chain: FormationTemplate[] = []
  const seen = new Set<string>([template.name])
  let parentName = template.parent
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (parentName === undefined) break
    const parent = index.get(parentName)
    if (parent === undefined || seen.has(parent.name)) break
    seen.add(parent.name)
    chain.push(parent)
    parentName = parent.parent
  }
  return chain
}

/**
 * 直近の親から根までの系統を返す。pool に居ない親でそこで止まる。
 *
 * 1 テンプレだけを走らせるとき、親ゲートを効かせるのに一緒に走らせる分を拾うのに使う。
 */
export function ancestorTemplates(
  template: FormationTemplate,
  pool: readonly FormationTemplate[],
): FormationTemplate[] {
  return ancestorChain(template, nameIndex(pool))
}

/**
 * 親ゲートで裏付けを見る相手。カテゴリは盤の形を持たず単体では成立しないので、
 * 系統の途中に挟まっていても**素通し**して非カテゴリの祖先まで登る。
 * (ここでカテゴリを親として見ると、間に 1 つ挟んだだけで親ゲートが効かなくなる)
 */
function gateParent(
  template: FormationTemplate,
  index: ReadonlyMap<string, FormationTemplate>,
): FormationTemplate | undefined {
  return ancestorChain(template, index).find((ancestor) => ancestor.category !== true)
}

/**
 * 親が成立していない子の成立を落とす。
 *
 * 親が成立していないのに子だけ発火するのは、定義かデータのどちらかが崩れている。
 *
 * - 見るのは**同じ陣営**。相手が親を作っていても子の裏付けにはならない
 * - 親の成立は**子の成立手数まで**に済んでいること。子より後に成立した親は間に合っていない
 * - 親が落ちれば孫も落ちる (根まで遡って生き残ったものだけ残す)
 * - 親が走査集合に居ないときは判定しようが無いので素通しする
 * - **カテゴリは素通しの節**。そもそも成立しないので裏付けを求めれば必ず落ちる。
 *   見る相手はその先の非カテゴリの祖先まで登る (gateParent)
 */
export function dropUnestablishedChildren(
  detections: readonly DetectedTemplateAt[],
  templates: readonly FormationTemplate[],
): DetectedTemplateAt[] {
  if (!templates.some((template) => template.parent !== undefined)) return [...detections]
  const index = nameIndex(templates)
  const byKey = new Map<string, DetectedTemplateAt>()
  for (const detected of detections) {
    byKey.set(`${detected.template.name}|${detected.side}`, detected)
  }
  const verdict = new Map<string, boolean>()

  // 系統を根まで遡る。visiting はデータ側の循環で無限に潜らないための保険
  const isEstablished = (detected: DetectedTemplateAt, visiting: Set<string>): boolean => {
    const key = `${detected.template.name}|${detected.side}`
    const memo = verdict.get(key)
    if (memo !== undefined) return memo
    // 循環はそこで打ち切る (定義側の壊れなので、判定まで巻き込まない)
    if (visiting.has(key)) return true
    visiting.add(key)
    const parent = gateParent(detected.template, index)
    const parentDetected =
      parent === undefined ? undefined : byKey.get(`${parent.name}|${detected.side}`)
    const ok =
      parent === undefined ||
      (parentDetected !== undefined &&
        parentDetected.ply <= detected.ply &&
        isEstablished(parentDetected, visiting))
    visiting.delete(key)
    verdict.set(key, ok)
    return ok
  }
  return detections.filter((detected) => isEstablished(detected, new Set()))
}

/**
 * テンプレごとの「上から数えた代の深さ」 — 親を辿れる代の数。
 *
 * 同じ手で 2 つ以上成立したときの並び順にだけ使う (order.ts)。検出からの距離では
 * なく**そのテンプレ自身の祖先の数**で測る。カテゴリも 1 代として数えるので、
 * 分類の下にぶら下がる具体の定義は、その分類より必ず深くなる。
 *
 * 親が `templates` に居なければそこで打ち切る。系統の付いていないテンプレは 0。
 */
export function ancestorDepths(
  templates: readonly FormationTemplate[],
): Map<FormationTemplate, number> {
  const index = nameIndex(templates)
  const depths = new Map<FormationTemplate, number>()
  for (const template of templates) {
    depths.set(template, ancestorChain(template, index).length)
  }
  return depths
}
