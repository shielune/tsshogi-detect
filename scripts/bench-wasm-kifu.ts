// WASM の走査器 (tsshogi-detect/wasm の recordMany) を実際の棋譜で測る。bun でも node でも動く。
//
//   bun scripts/bench-wasm-kifu.ts [--threads 6] [--every 125] [--sample 20000]
//       [--rust-dump 標本.i32] [--skip-original] <棋譜.usi.gz>...
//   node scripts/bench-wasm-kifu.ts ...   (node は型を剥いで .ts をそのまま読む)
//
// 定義は bench-definitions.ts の控えだけを読む。先に bench-encode-definitions.ts を回して
// 控えを更新しておけば、rust/examples/bench.rs に渡す符号と同じ定義になる。
// 囲いと戦法を bench-compare.ts と同じ指定で回す。
//
// 1. 1 本: 全局を recordMany で回す。ファイルの読み込みを含まず、先頭の 500 局で温めてから
//    数える。recordMany の中の USI の符号化と、出力を定義のオブジェクトに戻すところは含む。
// 2. --threads 本: worker を立て、局を通し番号で振り分けて回す。各 worker が走査に使った時間の
//    和を返し、いちばん遅い worker の和を N 本の時間とする (読み込みはここでも数えない)。
// 3. --every 局に 1 局 (最大 --sample 局) を元の走査 (recordDefinitions) でも回し、
//    名前|陣営|手数 の列を突き合わせる。--rust-dump を渡せば bench.rs の標本とも突き合わせる。
//
// 照合値は bench.rs と同じく、局ごとに検出の数と (定義の添字, 陣営, 手数) を FNV-1a で畳んだもの。

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { gunzipSync } from 'node:zlib'
import { Color } from 'tsshogi'
import type { DetectedDefinitionAt, FormationDefinition } from '../src/definition.ts'
import { buildMoves, recordDefinitions } from '../src/scan.ts'
import { type CompiledScan, loadScanner, type WasmScanOptions } from '../src/wasm/index.ts'
import { loadBenchDefinitions } from './bench-definitions.ts'

const WARMUP = 500
const OPTIONS: readonly [WasmScanOptions, WasmScanOptions] = [
  { moverOnly: true, requireParent: true, suppressGameEndIfDetected: true },
  { moverOnly: true, requireParent: true },
]
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

type Job = { readonly files: readonly string[]; readonly threads: number; readonly index: number }
type Done = { readonly scanMs: number; readonly detections: readonly [number, number] }

const readGames = (path: string): string[] => {
  const lines = new TextDecoder().decode(gunzipSync(readFileSync(path))).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
const splitUsis = (line: string): string[] => (line === '' ? [] : line.split(' '))
const fold = (hash: number, word: number): number => Math.imul(hash ^ word, FNV_PRIME) >>> 0
const hex = (hash: number): string => hash.toString(16).padStart(8, '0')
const keys = (detections: readonly DetectedDefinitionAt[]): string[] =>
  detections.map((detected) => `${detected.definition.name}|${detected.side}|${detected.ply}`)

async function compileBoth(): Promise<{
  readonly definitions: readonly [FormationDefinition[], FormationDefinition[]]
  readonly compiled: readonly [CompiledScan, CompiledScan]
  readonly rows: number
}> {
  const { castles, strategies, rows } = await loadBenchDefinitions(true)
  const scanner = await loadScanner()
  return {
    definitions: [castles, strategies],
    compiled: [scanner.compile(castles), scanner.compile(strategies)],
    rows,
  }
}

function warm(compiled: readonly [CompiledScan, CompiledScan], path: string): void {
  const games = readGames(path).slice(0, WARMUP).map(splitUsis)
  compiled[0].recordMany(games, OPTIONS[0])
  compiled[1].recordMany(games, OPTIONS[1])
}

/** worker 側。自分の番の局だけを回して、走査の時間の和を返す */
async function work(job: Job): Promise<void> {
  const { compiled } = await compileBoth()
  warm(compiled, job.files[0] as string)
  let scanMs = 0
  const detections: [number, number] = [0, 0]
  let offset = 0
  for (const path of job.files) {
    const lines = readGames(path)
    const games = lines.filter((_, k) => (offset + k) % job.threads === job.index).map(splitUsis)
    offset += lines.length
    for (const group of [0, 1] as const) {
      const start = performance.now()
      const results = compiled[group].recordMany(games, OPTIONS[group])
      scanMs += performance.now() - start
      for (const list of results) detections[group] += list.length
    }
  }
  parentPort?.postMessage({ scanMs, detections } satisfies Done)
}

function runWorkers(files: readonly string[], threads: number): Promise<Done[]> {
  return Promise.all(
    Array.from(
      { length: threads },
      (_, index) =>
        new Promise<Done>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), {
            workerData: { files, threads, index } satisfies Job,
          })
          worker.once('message', (done: Done) => {
            resolve(done)
            void worker.terminate()
          })
          worker.once('error', reject)
        }),
    ),
  )
}

type Sample = { readonly usis: string[]; readonly wasm: string[] }

/** 1 本で全局を回す */
function runSingle(
  compiled: readonly [CompiledScan, CompiledScan],
  definitions: readonly [FormationDefinition[], FormationDefinition[]],
  files: readonly string[],
  every: number,
  sampleLimit: number,
): {
  readonly games: number
  readonly scanMs: readonly [number, number]
  readonly detections: readonly [number, number]
  readonly hashes: readonly [number, number]
  readonly samples: Sample[]
} {
  const indexOf = definitions.map((list) => new Map(list.map((definition, k) => [definition, k])))
  const scanMs: [number, number] = [0, 0]
  const detections: [number, number] = [0, 0]
  const hashes: [number, number] = [FNV_OFFSET, FNV_OFFSET]
  const samples: Sample[] = []
  let games = 0
  for (const path of files) {
    const batch = readGames(path).map(splitUsis)
    const results = ([0, 1] as const).map((group) => {
      const start = performance.now()
      const result = compiled[group].recordMany(batch, OPTIONS[group])
      scanMs[group] += performance.now() - start
      return result
    })
    batch.forEach((usis, k) => {
      for (const group of [0, 1] as const) {
        const list = results[group]?.[k] ?? []
        detections[group] += list.length
        let hash = fold(hashes[group], list.length)
        for (const detected of list) {
          hash = fold(hash, indexOf[group]?.get(detected.definition) ?? -1)
          hash = fold(hash, detected.side === Color.BLACK ? 0 : 1)
          hash = fold(hash, detected.ply)
        }
        hashes[group] = hash
      }
      if ((games + k) % every === 0 && samples.length < sampleLimit) {
        samples.push({ usis, wasm: [...keys(results[0]?.[k] ?? []), ...keys(results[1]?.[k] ?? [])] })
      }
    })
    games += batch.length
    const ms = (scanMs[0] + scanMs[1]) / games
    console.log(`${basename(path)}: 累計 ${games} 局, ${ms.toFixed(4)} ms/局`)
  }
  return { games, scanMs, detections, hashes, samples }
}

/** bench.rs の標本 (局ごとに囲い・戦法の出力) を 名前|陣営|手数 の列と合法な手の数に戻す */
function readRustDump(
  path: string,
  definitions: readonly [FormationDefinition[], FormationDefinition[]],
): { readonly legal: number; readonly keys: string[] }[] {
  const bytes = readFileSync(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const word = (): number => {
    const value = view.getInt32(at, true)
    at += 4
    return value
  }
  const games: { legal: number; keys: string[] }[] = []
  while (at < bytes.byteLength) {
    let legal = 0
    const found: string[] = []
    for (const group of [0, 1] as const) {
      legal = word()
      const count = word()
      for (let k = 0; k < count; k += 1) {
        const name = definitions[group][word()]?.name ?? '?'
        const side = word() === 0 ? Color.BLACK : Color.WHITE
        found.push(`${name}|${side}|${word()}`)
      }
    }
    games.push({ legal, keys: found })
  }
  return games
}

async function main(): Promise<void> {
  const { values, positionals: files } = parseArgs({
    args: process.argv.slice(2),
    options: {
      threads: { type: 'string' },
      every: { type: 'string' },
      sample: { type: 'string' },
      'rust-dump': { type: 'string' },
      'skip-original': { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (files.length === 0) {
    console.error(
      'usage: bench-wasm-kifu.ts [--threads N] [--every N] [--sample N] [--rust-dump path] <games.usi.gz>...',
    )
    process.exit(1)
  }
  const threads = Number(values.threads ?? 6)
  const every = Number(values.every ?? 125)
  const sampleLimit = Number(values.sample ?? 20000)
  const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`

  const { definitions, compiled, rows } = await compileBoth()
  console.log(`${runtime}, 定義: 行 ${rows}, 囲い ${definitions[0].length}, 戦法 ${definitions[1].length}`)
  warm(compiled, files[0] as string)

  const single = runSingle(compiled, definitions, files, every, sampleLimit)
  const singleMs = single.scanMs[0] + single.scanMs[1]
  const per = (ms: number): string => (ms / single.games).toFixed(4)
  console.log(
    `1 本: ${per(singleMs)} ms/局 (囲い ${per(single.scanMs[0])}, 戦法 ${per(single.scanMs[1])}), ` +
      `計 ${(singleMs / 1000).toFixed(1)} s`,
  )
  console.log(
    `  検出 囲い ${single.detections[0]} 戦法 ${single.detections[1]}, ` +
      `照合値 囲い ${hex(single.hashes[0])} 戦法 ${hex(single.hashes[1])}`,
  )

  if (threads > 1) {
    const started = performance.now()
    const done = await runWorkers(files, threads)
    const wall = performance.now() - started
    const slowest = Math.max(...done.map((d) => d.scanMs))
    const sum = done.reduce<[number, number]>(
      (acc, d) => [acc[0] + d.detections[0], acc[1] + d.detections[1]],
      [0, 0],
    )
    const same = sum[0] === single.detections[0] && sum[1] === single.detections[1]
    console.log(
      `${threads} 本: 最も遅い worker の走査 ${(slowest / 1000).toFixed(1)} s ` +
        `(${per(slowest)} ms/局 相当, 1 本の ${(singleMs / slowest).toFixed(2)} 倍), ` +
        `読み込み込みの経過 ${(wall / 1000).toFixed(1)} s, 検出の数 ${same ? '1 本と同じ' : `違う ${sum}`}`,
    )
  }

  const rust = values['rust-dump'] === undefined ? undefined : readRustDump(values['rust-dump'], definitions)
  if (rust !== undefined && rust.length !== single.samples.length) {
    console.log(`Rust の標本が ${rust.length} 局で、こちらの ${single.samples.length} 局と数が違う`)
  }
  if (values['skip-original'] === true) return

  let originalMs = 0
  let wasmSame = 0
  let rustSame = 0
  let firstMismatch: string | undefined
  single.samples.forEach((sample, k) => {
    const start = performance.now()
    const moves = buildMoves(sample.usis)
    const original = [
      ...keys(recordDefinitions(definitions[0], moves, OPTIONS[0])),
      ...keys(recordDefinitions(definitions[1], moves, OPTIONS[1])),
    ].join('\n')
    originalMs += performance.now() - start
    if (sample.wasm.join('\n') === original) wasmSame += 1
    else firstMismatch ??= `標本 ${k} (WASM): ${sample.wasm.join(', ')} / 元: ${original}`
    const other = rust?.[k]
    if (other !== undefined && other.legal === moves.length && other.keys.join('\n') === original) {
      rustSame += 1
    } else if (other !== undefined) {
      firstMismatch ??= `標本 ${k} (Rust): 合法 ${other.legal}/${moves.length}, ${other.keys.join(', ')}`
    }
  })
  const n = single.samples.length
  console.log(`元 (標本 ${n} 局): buildMoves 込み ${(originalMs / n).toFixed(3)} ms/局`)
  console.log(`一致: WASM ${wasmSame}/${n}${rust === undefined ? '' : `, Rust ${rustSame}/${n}`}`)
  if (firstMismatch !== undefined) console.log(`最初の食い違い: ${firstMismatch}`)
}

if (isMainThread) await main()
else await work(workerData as Job)
