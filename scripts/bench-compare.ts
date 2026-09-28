// 元の走査 (recordDefinitions) と改良版 (bench-fast-scan.ts) の速さと一致を測る。
//
//   bun scripts/bench-compare.ts [--sample 20000] [--every 1] [--limit N] <棋譜.usi.gz>...
//
// 棋譜は convert-csa-kifu.ts が書く 1 行 1 局の USI。定義はアプリの dev サーバから取る
// (bench-definitions.ts)。囲いと戦法をアプリと同じ指定で走査する。
//
// 元は遅いので、--every 局に 1 局 (既定は全局) を最大 --sample 局だけ測り、そこで改良版と
// 結果 (名前|陣営|手数 の列) を突き合わせる。ファイルの頭は短い局に偏っていることがあるので、
// 標本は --every で散らすとよい。改良版と buildMoves は全局で測る。時間はファイルの読み込みを
// 含まず、先頭の 500 局で温めてから数える。ms/局 の分母は空の局も含めた行の数。

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import type { Move } from 'tsshogi'
import type { DetectedDefinitionAt } from '../src/definition.ts'
import { buildMoves, recordDefinitions } from '../src/scan.ts'
import { loadBenchDefinitions } from './bench-definitions.ts'
import { compileFastScanner, describeFastScanner, recordDefinitionsFast } from './bench-fast-scan.ts'

const WARMUP = 500

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { sample: { type: 'string' }, every: { type: 'string' }, limit: { type: 'string' } },
  allowPositionals: true,
})
if (positionals.length === 0) {
  console.error('usage: bun scripts/bench-compare.ts [--sample N] [--every N] [--limit N] <games.usi.gz>...')
  process.exit(1)
}
const sample = Number(values.sample ?? 20000)
const every = Number(values.every ?? 1)
const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit)

const definitions = await loadBenchDefinitions()
const { castles, strategies } = definitions
const fastCastles = compileFastScanner(castles)
const fastStrategies = compileFastScanner(strategies)
console.log(`定義: 行 ${definitions.rows}, 囲い ${castles.length}, 戦法 ${strategies.length}`)
console.log(`  囲い: ${describeFastScanner(fastCastles)}`)
console.log(`  戦法: ${describeFastScanner(fastStrategies)}`)

const original = (moves: readonly Move[]): DetectedDefinitionAt[] => [
  ...recordDefinitions(castles, moves, {
    moverOnly: true,
    requireParent: true,
    suppressGameEndIfDetected: true,
  }),
  ...recordDefinitions(strategies, moves, { moverOnly: true, requireParent: true }),
]
const fast = (moves: readonly Move[]): DetectedDefinitionAt[] => [
  ...recordDefinitionsFast(fastCastles, moves, {
    moverOnly: true,
    requireParent: true,
    suppressGameEndIfDetected: true,
  }),
  ...recordDefinitionsFast(fastStrategies, moves, { moverOnly: true, requireParent: true }),
]
const keys = (detections: readonly DetectedDefinitionAt[]): string[] =>
  detections.map((detected) => `${detected.definition.name}|${detected.side}|${detected.ply}`)

const readGames = (path: string): string[] => {
  const lines = new TextDecoder().decode(Bun.gunzipSync(readFileSync(path))).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
const splitUsis = (line: string): string[] => (line === '' ? [] : line.split(' '))
const perGame = (time: number, count: number): string => (count === 0 ? '-' : (time / count).toFixed(3))

// 温める。数えない
for (const line of readGames(positionals[0] as string).slice(0, WARMUP)) {
  const moves = buildMoves(splitUsis(line))
  original(moves)
  fast(moves)
}

type Mismatch = {
  readonly where: string
  readonly plies: number
  readonly missing: string[]
  readonly extra: string[]
}

let games = 0
let plies = 0
let truncated = 0
let buildTime = 0
let fastTime = 0
let sampled = 0
let samplePlies = 0
let sampleBuildTime = 0
let sampleFastTime = 0
let originalTime = 0
let agreed = 0
let mismatches = 0
let smallest: Mismatch | null = null
const started = performance.now()

for (const path of positionals) {
  if (games >= limit) break
  const lines = readGames(path).slice(0, limit - games)
  for (const [index, line] of lines.entries()) {
    games++
    const usis = splitUsis(line)
    const t0 = performance.now()
    const moves = buildMoves(usis)
    const t1 = performance.now()
    const got = fast(moves)
    const t2 = performance.now()
    buildTime += t1 - t0
    fastTime += t2 - t1
    plies += moves.length
    if (moves.length < usis.length) truncated++
    if (sampled >= sample || (games - 1) % every !== 0) continue
    sampled++
    samplePlies += moves.length
    sampleBuildTime += t1 - t0
    sampleFastTime += t2 - t1
    const t3 = performance.now()
    const expected = original(moves)
    originalTime += performance.now() - t3
    const a = keys(expected)
    const b = keys(got)
    if (a.join(',') === b.join(',')) {
      agreed++
      continue
    }
    mismatches++
    if (smallest === null || moves.length < smallest.plies) {
      smallest = {
        where: `${basename(path)}:${index + 1}`,
        plies: moves.length,
        missing: a.filter((key) => !b.includes(key)),
        extra: b.filter((key) => !a.includes(key)),
      }
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(0)
  const pace = perGame(fastTime, games)
  console.log(`${basename(path)}: 累計 ${games} 局, 改良版 ${pace} ms/局, 一致 ${agreed}/${sampled}, ${seconds} s`)
}

console.log('')
console.log(`局 ${games}, 合法な手 ${plies} (平均 ${perGame(plies, games)}), 途中で打ち切り ${truncated}`)
console.log(`buildMoves だけ: ${perGame(buildTime, games)} ms/局`)
console.log(
  `元 (標本 ${sampled} 局, 平均 ${perGame(samplePlies, sampled)} 手): 走査 ${perGame(originalTime, sampled)} ms/局,` +
    ` buildMoves 込み ${perGame(originalTime + sampleBuildTime, sampled)} ms/局`,
)
console.log(
  `改良版 (標本): 走査 ${perGame(sampleFastTime, sampled)} ms/局,` +
    ` buildMoves 込み ${perGame(sampleFastTime + sampleBuildTime, sampled)} ms/局`,
)
console.log(
  `改良版 (全 ${games} 局): 走査 ${perGame(fastTime, games)} ms/局,` +
    ` buildMoves 込み ${perGame(fastTime + buildTime, games)} ms/局,` +
    ` 計 ${((fastTime + buildTime) / 1000).toFixed(1)} s`,
)
console.log(`一致: ${agreed}/${sampled} (食い違い ${mismatches})`)
if (smallest !== null) {
  console.log(`手数の最も少ない食い違い: ${smallest.where} (${smallest.plies} 手)`)
  console.log(`  元にだけある: ${smallest.missing.join(', ') || '(無し。並びだけ違う)'}`)
  console.log(`  改良版にだけある: ${smallest.extra.join(', ') || '(無し。並びだけ違う)'}`)
}
