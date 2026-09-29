/**
 * TS 版の走査 (recordDefinitions) と WASM の走査器 (tsshogi-detect/wasm) の 1 局あたりの時間を比べる。
 * 棋譜は test/random-games.ts で乱数に指し進めたもの (種は固定)。先に bun run build:wasm が要る。
 *
 *   bun run scripts/bench-wasm.ts            # 既定は 400 局で比べ、WASM だけ 20000 局回す
 *   bun run scripts/bench-wasm.ts 1000 100000
 *
 * TS 版の時間には USI を Move にする buildMoves も含める (WASM 側も文字列から読むので)。
 */

import { KNOWN_CASTLES } from '../src/castle.ts'
import type { FormationDefinition } from '../src/definition.ts'
import { buildMoves, recordDefinitions } from '../src/scan.ts'
import { KNOWN_STRATEGIES } from '../src/strategy.ts'
import { loadScanner, type WasmScanOptions } from '../src/wasm/index.ts'
import { randomGames } from '../test/random-games.ts'

const compareCount = Number(process.argv[2] ?? 400)
const throughputCount = Number(process.argv[3] ?? 20000)

const CASES: readonly {
  readonly name: string
  readonly definitions: readonly FormationDefinition[]
  readonly options: WasmScanOptions
}[] = [
  // recordCastles と recordStrategies が渡す options に合わせる
  { name: 'castles', definitions: KNOWN_CASTLES, options: { suppressGameEndIfDetected: true } },
  { name: 'strategies', definitions: KNOWN_STRATEGIES, options: { moverOnly: true, requireParent: true } },
]

function time(run: () => void): number {
  const start = performance.now()
  run()
  return performance.now() - start
}

const perGame = (ms: number, games: number): string => `${((ms * 1000) / games).toFixed(1)} µs/局`

const games = randomGames(20260928, compareCount, { plies: 120, kingDropRate: 0.005 })
const plies = games.reduce((sum, game) => sum + game.length, 0)
console.log(`比べる棋譜: ${games.length} 局 (平均 ${(plies / games.length).toFixed(1)} 手)`)

const scanner = await loadScanner()
for (const { name, definitions, options } of CASES) {
  const compiled = scanner.compile(definitions)
  // 1 回目は JIT の温まりを待つだけにして捨てる
  compiled.recordMany(games.slice(0, 20), options)
  for (const usis of games.slice(0, 20)) recordDefinitions(definitions, buildMoves(usis), options)

  const ts = time(() => {
    for (const usis of games) recordDefinitions(definitions, buildMoves(usis), options)
  })
  const wasm = time(() => compiled.recordMany(games, options))
  console.log(
    `${name} (${definitions.length} 定義): TS ${perGame(ts, games.length)}, ` +
      `WASM ${perGame(wasm, games.length)}, ${(ts / wasm).toFixed(1)} 倍`,
  )
  compiled.release()
}

// WASM だけで局数を増やす。棋譜は比べたものを繰り返し並べる
const many = Array.from({ length: throughputCount }, (_, k) => games[k % games.length] ?? [])
for (const { name, definitions, options } of CASES) {
  const compiled = scanner.compile(definitions)
  const ms = time(() => compiled.recordMany(many, options))
  console.log(
    `${name} WASM ${many.length} 局: ${ms.toFixed(0)} ms (${perGame(ms, many.length)}, ` +
      `${Math.round((many.length / ms) * 1000)} 局/秒)`,
  )
  compiled.release()
}
