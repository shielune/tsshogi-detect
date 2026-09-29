// ベンチの定義 (bench-definitions.ts) を走査器の符号 (src/wasm/encode.ts) にして書き出す。
// rust/examples/bench.rs が読む。
//
//   bun scripts/bench-encode-definitions.ts [--out scripts/.cache]
//
// 囲いは <out>/castles.i32、戦法は <out>/strategies.i32 (i32 の little endian)。
// 定義はサーバから取り直して控えも更新するので、同じ回の bench-wasm-kifu.ts は控えを読めば揃う。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { encodeDefinitions } from '../src/wasm/encode.ts'
import { loadBenchDefinitions } from './bench-definitions.ts'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: 'string' } },
})
const out = values.out ?? join(import.meta.dirname, '.cache')

const { castles, strategies, rows } = await loadBenchDefinitions()
mkdirSync(out, { recursive: true })
for (const [name, definitions] of [
  ['castles', castles],
  ['strategies', strategies],
] as const) {
  const words = encodeDefinitions(definitions)
  const path = join(out, `${name}.i32`)
  // Int32Array は環境の並びで書かれるので、little endian に揃えて書く
  const view = new DataView(new ArrayBuffer(words.length * 4))
  words.forEach((word, k) => view.setInt32(k * 4, word, true))
  writeFileSync(path, new Uint8Array(view.buffer))
  console.log(`${path}: ${definitions.length} 定義, ${words.length} 語`)
}
console.log(`行 ${rows}`)
