/**
 * 2 つの版のテンプレートデータを比べ、増えた / 消えた / 定義が変わったものを並べる。
 * リリースノートと CHANGELOG の「どの戦法が増えたか」を手で数えずに済ませるための道具。
 *
 *   bun run scripts/diff-templates.ts v0.1.0           # その版と作業ツリー
 *   bun run scripts/diff-templates.ts v0.1.0 v0.2.0    # 版どうし
 *   bun run scripts/diff-templates.ts v0.1.0 --all     # 名前を省略せず全部出す
 *
 * 前の版の .gen.ts は src/ の中に一時ファイルとして展開してから読む。あそこは
 * `./requirements.ts` を相対で import していて、別の場所に置くと同じクラスが別物に
 * なり、instanceof を見る比較が狂う。
 */

import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TemplateRequirement } from '../src/requirements.ts'
import type { FormationTemplate } from '../src/template.ts'

const SRC = join(import.meta.dir, '..', 'src')

/** 比べる母集団。定数名は .gen.ts が export しているもの。 */
const TARGETS = [
  { label: '囲い', file: 'castles.gen.ts', constant: 'KNOWN_CASTLES' },
  { label: '戦法', file: 'strategies.gen.ts', constant: 'KNOWN_STRATEGIES' },
] as const

type Target = (typeof TARGETS)[number]

/** 名前を省略せずに並べる上限。これを超えたら件数だけ言う (--all で解除)。 */
const LIST_LIMIT = 20

/**
 * テンプレートを部位ごとに分けて文字列にする。変わったものについて「どこが」まで
 * 言えるように、1 本の指紋ではなく部位ごとに持つ。
 */
type Facets = ReadonlyMap<string, string>

/** 要件 1 件の文字列表現。クラス名を頭に付けないと、同じ升を指す別種の要件が同一に見える。 */
function requirementKey(requirement: TemplateRequirement): string {
  const fields = Object.entries(requirement as unknown as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  return `${requirement.constructor.name}(${fields.join(',')})`
}

function facets(template: FormationTemplate): Facets {
  const map = new Map<string, string>()
  const put = (key: string, value: unknown): void => {
    if (value === undefined) return
    map.set(key, JSON.stringify(value))
  }
  put('別名', template.aliases)
  put('親', template.parent)
  put('side', template.side)
  put('分類の節', template.category)
  put('成立手数', [template.plyEq, template.plyMin, template.plyMax])
  put('終局評価', template.evaluateAtGameEnd)
  put('打ちの排除', template.noDrop)
  put('角交換', template.bishopExchange)
  put('最終手', template.finishMoves)
  map.set('盤の形', template.placements.map(requirementKey).join(' '))
  return map
}

/** 変わった部位の名前。両方に在る部位だけでなく、片方にしか無い部位も拾う。 */
function changedFacets(before: Facets, after: Facets): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  const changed: string[] = []
  for (const key of keys) {
    if (before.get(key) !== after.get(key)) changed.push(key)
  }
  return changed
}

const REPOSITORY = join(import.meta.dir, '..')

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: REPOSITORY,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 失敗はこちらで読んで言い換えるので、git の言い分をそのまま流さない。
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 版そのものが無ければ、打ち間違いとして分かる形で止める。 */
function verify(ref: string): void {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  } catch {
    console.error(`${ref} という版が無い`)
    process.exit(1)
  }
}

/**
 * `git show <ref>:<path>` の中身。その版にそのファイルがまだ無ければ null。
 * 戦法は途中から入ったので、初期の版と比べるとこちらに来る。
 */
function show(ref: string, path: string): string | null {
  try {
    return git(['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

/**
 * ある版のテンプレート列を読む。ref を省くと作業ツリーのものをそのまま読む。
 *
 * 一時ファイルは src/ の中にしか置けない (冒頭の注記)。名前がぶつからないよう
 * ref を混ぜ、読み終えたら必ず消す。
 */
async function load(target: Target, ref?: string): Promise<readonly FormationTemplate[]> {
  const path = ref === undefined ? join(SRC, target.file) : temporary(target, ref)
  if (path === null) return []
  try {
    const module = (await import(path)) as Record<string, readonly FormationTemplate[]>
    const templates = module[target.constant]
    if (templates === undefined) {
      throw new Error(`${target.constant} が無い (${ref ?? '作業ツリー'})`)
    }
    return templates
  } finally {
    if (ref !== undefined) rmSync(path, { force: true })
  }
}

/** その版の中身を src/ の中に落とす。まだ無いファイルなら null。 */
function temporary(target: Target, ref: string): string | null {
  const source = show(ref, `src/${target.file}`)
  if (source === null) return null
  const slug = ref.replace(/[^\w.-]/g, '_')
  const path = join(SRC, `.diff-${slug}-${target.file}`)
  writeFileSync(path, source)
  return path
}

/** 名前 → テンプレート。同名が複数あれば後勝ちだが、データ側でそれは起きない。 */
function byName(templates: readonly FormationTemplate[]): Map<string, FormationTemplate> {
  return new Map(templates.map((template) => [template.name, template]))
}

type Diff = {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly { readonly name: string; readonly facets: readonly string[] }[]
}

function diff(
  before: readonly FormationTemplate[],
  after: readonly FormationTemplate[],
): Diff {
  const old = byName(before)
  const now = byName(after)
  const added: string[] = []
  const removed: string[] = []
  const changed: { name: string; facets: string[] }[] = []
  for (const [name, template] of now) {
    const previous = old.get(name)
    if (previous === undefined) {
      added.push(name)
      continue
    }
    const where = changedFacets(facets(previous), facets(template))
    if (where.length > 0) changed.push({ name, facets: where })
  }
  for (const name of old.keys()) {
    if (!now.has(name)) removed.push(name)
  }
  return { added, removed, changed }
}

/** 長い列は件数に丸める。--all なら丸めない。 */
function list(names: readonly string[], all: boolean): string {
  if (all || names.length <= LIST_LIMIT) return names.join('、')
  return `${names.slice(0, LIST_LIMIT).join('、')} ほか ${names.length - LIST_LIMIT} 件`
}

function report(target: Target, before: number, after: number, result: Diff, all: boolean): void {
  // どちらの版にもまだ無いもの (戦法は途中から入った)。言うことが無いので黙る。
  if (before === 0 && after === 0) return
  const count = before === after ? `${after} 件` : `${before} 件から ${after} 件へ`
  console.log(`\n## ${target.label} (${count})`)
  if (result.added.length === 0 && result.removed.length === 0 && result.changed.length === 0) {
    console.log('  変わりなし')
    return
  }
  if (result.added.length > 0) {
    console.log(`  増えた (${result.added.length} 件): ${list(result.added, all)}`)
  }
  if (result.removed.length > 0) {
    console.log(`  消えた (${result.removed.length} 件): ${list(result.removed, all)}`)
  }
  for (const entry of result.changed) {
    console.log(`  定義が変わった: ${entry.name} — ${entry.facets.join('、')}`)
  }
}

const args = process.argv.slice(2)
const all = args.includes('--all')
const refs = args.filter((arg) => !arg.startsWith('-'))
const base = refs[0]
const head = refs[1]

if (base === undefined) {
  console.error('比べる元の版が要る (例: bun run scripts/diff-templates.ts v0.1.0)')
  process.exit(1)
}

verify(base)
if (head !== undefined) verify(head)

console.log(`${base} から ${head ?? '作業ツリー'} へ`)

for (const target of TARGETS) {
  const before = await load(target, base)
  const after = await load(target, head)
  report(target, before.length, after.length, diff(before, after), all)
}
