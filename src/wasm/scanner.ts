/**
 * WASM の走査器の包み。線形メモリへの出し入れと、出力の整数列を
 * recordDefinitions と同じ形 (定義は渡されたオブジェクトそのもの) に戻すところを持つ。
 *
 * 取り決めは rust/src/lib.rs の冒頭の文書。入力の領域は呼ぶ側 (ここ) が確保し、
 * compile / scan から戻ったら解放する。alloc はバイト単位で揃えを約束しないので、
 * 書き込みも読み出しもバイトの写しで行う。
 */

import { Color } from 'tsshogi'
import type { DetectedDefinitionAt, FormationDefinition } from '../definition.ts'
import {
  encodeDefinitions,
  encodeGames,
  optionBits,
  SCAN_BITS,
} from './encode.ts'

/** WASM が出す関数 (lib.rs の「呼び出し (FFI)」)。 */
export interface ScannerExports {
  readonly memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(ptr: number, len: number): void
  compile(ptr: number, words: number): number
  compile_pair(aPtr: number, aWords: number, bPtr: number, bWords: number): number
  release(handle: number): void
  scan(
    handle: number,
    movesPtr: number,
    movesLen: number,
    lensPtr: number,
    games: number,
    options: number,
  ): number
  scan_pair(
    handle: number,
    movesPtr: number,
    movesLen: number,
    lensPtr: number,
    games: number,
    aOptions: number,
    bOptions: number,
  ): number
  out_ptr(): number
  out_len(): number
}

/** WASM の走査で受け付ける options。初期局面 (`initial`) は受けない (平手だけ)。 */
export interface WasmScanOptions {
  readonly moverOnly?: boolean
  readonly requireParent?: boolean
  readonly suppressGameEndIfDetected?: boolean
}

export interface WasmScanWithDropped {
  readonly detections: DetectedDefinitionAt[]
  readonly dropped: DetectedDefinitionAt[]
}

/** 最後の局面 (option bit 16)。升の中身は lib.rs の符号のまま。 */
export interface ScannedPosition {
  readonly cells: readonly number[]
  readonly blackHand: readonly number[]
  readonly whiteHand: readonly number[]
  readonly turn: number
}

/** 1 局ぶんの生の出力。 */
export interface RawScanResult {
  /** buildMoves が返す長さ (不正な手に当たったらそこまで)。 */
  readonly legalLength: number
  readonly position?: ScannedPosition
  readonly detections: DetectedDefinitionAt[]
  readonly dropped?: DetectedDefinitionAt[]
}

/** 1 回の scan に渡す局数の上限。出力域が際限なく膨らまないよう分けて回す。 */
const CHUNK_GAMES = 2000

const POSITION_WORDS = 81 + 7 + 7 + 1

/** 線形メモリへバイト列を写し、`use` から戻ったら解放する。 */
function withBuffer<T>(exports: ScannerExports, bytes: Uint8Array, use: (ptr: number) => T): T {
  // 長さ 0 の確保は実装によって扱いが違うので、最低 1 バイト取る
  const size = Math.max(bytes.byteLength, 1)
  const ptr = exports.alloc(size)
  if (ptr === 0) throw new Error('WASM scanner: alloc failed')
  try {
    // alloc でメモリが伸びると以前の buffer は切り離されるので、毎回取り直す
    new Uint8Array(exports.memory.buffer).set(bytes, ptr)
    return use(ptr)
  } finally {
    exports.dealloc(ptr, size)
  }
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/** 出力域を写して読む。揃っていない番地でも読めるよう、バイトを写してから Int32Array にする */
function readOutput(exports: ScannerExports): Int32Array {
  const ptr = exports.out_ptr()
  const words = exports.out_len()
  const copy = new Uint8Array(words * 4)
  copy.set(new Uint8Array(exports.memory.buffer, ptr, words * 4))
  return new Int32Array(copy.buffer)
}

/** WASM の走査器 1 つ。loadScanner か instantiateScanner で作る。 */
export class WasmScanner {
  readonly #exports: ScannerExports

  constructor(exports: ScannerExports) {
    this.#exports = exports
  }

  /**
   * 定義の列を読み込む。符号にできない定義が混じっていれば UnsupportedDefinitionError を
   * 投げるので、呼ぶ側は TS 版の走査へ戻す。
   */
  compile(definitions: readonly FormationDefinition[]): CompiledScan {
    const words = encodeDefinitions(definitions)
    const handle = withBuffer(this.#exports, bytesOf(words), (ptr) =>
      this.#exports.compile(ptr, words.length),
    )
    if (handle === 0) throw new Error('WASM scanner: compile rejected the definitions')
    return new CompiledScan(this.#exports, handle, definitions)
  }

  /**
   * 定義の列を 2 組読み、1 つの走査器にまとめる。棋譜は 1 回指すだけで両方の答えが出るので、
   * 囲いと戦法のように別々に走らせている 2 組を回すなら、別々の compile より速い。
   * 組どうしは名前も親子も別々に扱う。符号にできない定義が混じっていれば
   * UnsupportedDefinitionError を投げる。
   */
  compilePair(
    first: readonly FormationDefinition[],
    second: readonly FormationDefinition[],
  ): CompiledPair {
    const a = encodeDefinitions(first)
    const b = encodeDefinitions(second)
    const handle = withBuffer(this.#exports, bytesOf(a), (aPtr) =>
      withBuffer(this.#exports, bytesOf(b), (bPtr) =>
        this.#exports.compile_pair(aPtr, a.length, bPtr, b.length),
      ),
    )
    if (handle === 0) throw new Error('WASM scanner: compile rejected the definitions')
    return new CompiledPair(this.#exports, handle, first, second)
  }
}

let scanRawOf: (
  compiled: CompiledScan,
  games: readonly (readonly string[])[],
  bits: number,
) => RawScanResult[]

/**
 * options の bit をそのまま渡して走査し、生の出力を局ごとに返す (照合試験用)。
 * 公開の入口 (index.ts) からは出さない。
 */
export function scanRaw(
  compiled: CompiledScan,
  games: readonly (readonly string[])[],
  bits: number,
): RawScanResult[] {
  return scanRawOf(compiled, games, bits)
}

/** 読み込み済みの定義の列。使い終えたら release() する。 */
export class CompiledScan {
  static {
    scanRawOf = (compiled, games, bits) => compiled.#scan(games, bits)
  }

  readonly #exports: ScannerExports
  readonly #definitions: readonly FormationDefinition[]
  #handle: number

  constructor(exports: ScannerExports, handle: number, definitions: readonly FormationDefinition[]) {
    this.#exports = exports
    this.#handle = handle
    this.#definitions = [...definitions]
  }

  /** recordDefinitions(definitions, buildMoves(usis), options) と同じ結果。 */
  record(usis: readonly string[], options: WasmScanOptions = {}): DetectedDefinitionAt[] {
    return this.recordMany([usis], options)[0] ?? []
  }

  /** recordDefinitionsWithDropped と同じ結果。 */
  recordWithDropped(usis: readonly string[], options: WasmScanOptions = {}): WasmScanWithDropped {
    return this.recordManyWithDropped([usis], options)[0] ?? { detections: [], dropped: [] }
  }

  /** 局ごとの record をまとめて。 */
  recordMany(
    games: readonly (readonly string[])[],
    options: WasmScanOptions = {},
  ): DetectedDefinitionAt[][] {
    return this.#scan(games, optionBits(checked(options))).map((game) => game.detections)
  }

  /** 局ごとの recordWithDropped をまとめて。 */
  recordManyWithDropped(
    games: readonly (readonly string[])[],
    options: WasmScanOptions = {},
  ): WasmScanWithDropped[] {
    const bits = optionBits(checked(options)) | SCAN_BITS.withDropped
    return this.#scan(games, bits).map((game) => ({
      detections: game.detections,
      dropped: game.dropped ?? [],
    }))
  }

  /** 定義の列を手放す。以後この CompiledScan は使えない。 */
  release(): void {
    if (this.#handle === 0) return
    this.#exports.release(this.#handle)
    this.#handle = 0
  }

  #scan(games: readonly (readonly string[])[], bits: number): RawScanResult[] {
    if (this.#handle === 0) throw new Error('WASM scanner: this CompiledScan was released')
    const results: RawScanResult[] = []
    for (let start = 0; start < games.length; start += CHUNK_GAMES) {
      const chunk = games.slice(start, start + CHUNK_GAMES)
      results.push(...this.#scanChunk(chunk, bits))
    }
    return results
  }

  #scanChunk(games: readonly (readonly string[])[], bits: number): RawScanResult[] {
    const exports = this.#exports
    const { moves, lengths } = encodeGames(games)
    const status = withBuffer(exports, moves, (movesPtr) =>
      withBuffer(exports, bytesOf(lengths), (lensPtr) =>
        exports.scan(this.#handle, movesPtr, moves.byteLength, lensPtr, games.length, bits),
      ),
    )
    if (status !== 0) throw new Error(`WASM scanner: scan failed with status ${status}`)
    return readResults(exports, [this.#definitions], games.length, [bits]).map(
      (game) => game[0] as RawScanResult,
    )
  }
}

/**
 * 出力域を局ごとに読む。局ごとに、合法な手の数、(最初の組の options に最後の局面があれば)
 * 最後の局面、組ごとの検出 (と落ちた検出) の順に並んでいる。`groups` は組ごとの定義、
 * `bits` は組ごとの options。返すのは局 x 組。
 */
function readResults(
  exports: ScannerExports,
  groups: readonly (readonly FormationDefinition[])[],
  games: number,
  bits: readonly number[],
): RawScanResult[][] {
  const out = readOutput(exports)
  let at = 0
  const word = (): number => {
    if (at >= out.length) throw new Error('WASM scanner: output ended early')
    return out[at++] as number
  }
  const triples = (definitions: readonly FormationDefinition[]): DetectedDefinitionAt[] => {
    const count = word()
    const list: DetectedDefinitionAt[] = []
    for (let k = 0; k < count; k += 1) {
      const index = word()
      const side = word()
      const ply = word()
      const definition = definitions[index]
      if (definition === undefined) throw new Error(`WASM scanner: unknown definition ${index}`)
      if (side !== 0 && side !== 1) throw new Error(`WASM scanner: unknown side ${side}`)
      list.push({ definition, side: side === 0 ? Color.BLACK : Color.WHITE, ply })
    }
    return list
  }
  const results: RawScanResult[][] = []
  for (let game = 0; game < games; game += 1) {
    const legalLength = word()
    let position: ScannedPosition | undefined
    if (((bits[0] ?? 0) & SCAN_BITS.finalPosition) !== 0) {
      const words = Array.from({ length: POSITION_WORDS }, word)
      position = {
        cells: words.slice(0, 81),
        blackHand: words.slice(81, 88),
        whiteHand: words.slice(88, 95),
        turn: words[95] as number,
      }
    }
    results.push(
      groups.map((definitions, group) => {
        const detections = triples(definitions)
        const dropped =
          ((bits[group] ?? 0) & SCAN_BITS.withDropped) !== 0 ? triples(definitions) : undefined
        return {
          legalLength,
          // 最後の局面は最初の組にだけ付ける
          ...(position === undefined || group !== 0 ? {} : { position }),
          detections,
          ...(dropped === undefined ? {} : { dropped }),
        }
      }),
    )
  }
  if (at !== out.length) throw new Error('WASM scanner: output has trailing words')
  return results
}

/**
 * 読み込み済みの定義の 2 組 (compilePair)。囲いと戦法のように、名前も親子も別々に扱う
 * 2 組を、棋譜を 1 回指すだけで走査する。使い終えたら release() する。
 */
export class CompiledPair {
  readonly #exports: ScannerExports
  readonly #definitions: readonly [readonly FormationDefinition[], readonly FormationDefinition[]]
  #handle: number

  constructor(
    exports: ScannerExports,
    handle: number,
    first: readonly FormationDefinition[],
    second: readonly FormationDefinition[],
  ) {
    this.#exports = exports
    this.#handle = handle
    this.#definitions = [[...first], [...second]]
  }

  /**
   * 局ごとの recordMany を 2 組ぶん。組ごとに options を変えられる (囲いは
   * suppressGameEndIfDetected、戦法は付けない、など)。返すのは [1 組めの答え, 2 組めの答え]。
   */
  recordMany(
    games: readonly (readonly string[])[],
    firstOptions: WasmScanOptions = {},
    secondOptions: WasmScanOptions = {},
  ): [DetectedDefinitionAt[][], DetectedDefinitionAt[][]] {
    if (this.#handle === 0) throw new Error('WASM scanner: this CompiledPair was released')
    const bits = [optionBits(checked(firstOptions)), optionBits(checked(secondOptions))] as const
    const first: DetectedDefinitionAt[][] = []
    const second: DetectedDefinitionAt[][] = []
    for (let start = 0; start < games.length; start += CHUNK_GAMES) {
      const chunk = games.slice(start, start + CHUNK_GAMES)
      for (const game of this.#scanChunk(chunk, bits)) {
        first.push(game[0]?.detections ?? [])
        second.push(game[1]?.detections ?? [])
      }
    }
    return [first, second]
  }

  /** 定義の 2 組を手放す。以後この CompiledPair は使えない。 */
  release(): void {
    if (this.#handle === 0) return
    this.#exports.release(this.#handle)
    this.#handle = 0
  }

  #scanChunk(
    games: readonly (readonly string[])[],
    bits: readonly [number, number],
  ): RawScanResult[][] {
    const exports = this.#exports
    const { moves, lengths } = encodeGames(games)
    const status = withBuffer(exports, moves, (movesPtr) =>
      withBuffer(exports, bytesOf(lengths), (lensPtr) =>
        exports.scan_pair(
          this.#handle,
          movesPtr,
          moves.byteLength,
          lensPtr,
          games.length,
          bits[0],
          bits[1],
        ),
      ),
    )
    if (status !== 0) throw new Error(`WASM scanner: scan failed with status ${status}`)
    return readResults(exports, this.#definitions, games.length, bits)
  }
}

/** 平手以外は扱わない。`initial` を渡されたら黙って平手で回さずに断る */
function checked(options: WasmScanOptions): WasmScanOptions {
  if ('initial' in options && (options as { initial?: unknown }).initial !== undefined) {
    throw new Error('WASM scanner: options.initial is not supported (hirate only)')
  }
  return options
}

/**
 * WASM のバイト列から走査器を作る。ブラウザの主スレッドでも使えるよう非同期で組む。
 *
 * `instantiate(bytes)` の一手で済ませず compile と分けるのは型のため。使う側が
 * `@cloudflare/workers-types` と `bun-types` を一緒に読むと `instantiate` の多重定義が
 * 混ざり、バイト列を渡しても Module を渡した形 (戻り値が Instance) に解決されて tsc が
 * 落ちる。Module を渡す形はどちらの型でも同じなので、こちらに寄せる。
 */
export async function instantiateScanner(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<WasmScanner> {
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(module, {})
  return new WasmScanner(instance.exports as unknown as ScannerExports)
}
