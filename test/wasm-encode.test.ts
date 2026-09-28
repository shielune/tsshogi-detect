// WASM の走査器へ渡す符号 (src/wasm/encode.ts) と、出力を読み戻す包み (src/wasm/scanner.ts)。
// 語の並びは rust/src/lib.rs の冒頭の文書を見ながら手で書いた値と比べる。
// 包みの方は WASM の代わりに JS で組んだ偽の exports を使うので、走査器が無くても回る。

import { describe, expect, test } from 'bun:test'
import { Color, PieceType } from 'tsshogi'
import type { FormationDefinition } from '../src/definition.ts'
import { definitionOrderTiers } from '../src/order.ts'
import {
  AnyOfPieces,
  AnyPiece,
  type DefinitionRequirement,
  EmptySquare,
  HandPiece,
  KingIgyoku,
  NotOfPieces,
  PieceAnywhere,
  PieceInSquares,
  PiecePlacement,
  PieceUnmoved,
  PieceVisited,
} from '../src/requirements.ts'
import {
  encodeDefinitions,
  encodeGames,
  FORMAT_VERSION,
  optionBits,
  SCAN_BITS,
  UnsupportedDefinitionError,
} from '../src/wasm/encode.ts'
import { type ScannerExports, scanRaw, WasmScanner } from '../src/wasm/scanner.ts'

/** 定義 1 件だけを符号にして、先頭 3 語 (版・定義の数・名前の数) を除いた本体を返す */
const body = (definition: FormationDefinition): number[] => [
  ...encodeDefinitions([definition]).slice(3),
]

/** 要件の種別ごとの語数 (種別の番号を除く)。6 は升の数で変わる */
const REQUIREMENT_WORDS: Readonly<Record<number, number>> = {
  1: 4,
  2: 3,
  3: 2,
  4: 4,
  5: 2,
  7: 1,
  8: 2,
  9: 2,
  10: 3,
  11: 0,
}

type DecodedDefinition = {
  readonly nameId: number
  readonly flags: number
  readonly ply: readonly [number, number, number]
  readonly bishopExchange: number
  readonly gateParent: number
  readonly tier: number
  readonly finishMoves: readonly number[][]
  readonly placements: readonly number[][]
}

/** lib.rs の「定義の符号」を読み戻す。語が余っても足りなくても投げる */
function decode(words: Int32Array): { header: number[]; definitions: DecodedDefinition[] } {
  let at = 0
  const next = (): number => {
    const value = words[at++]
    if (value === undefined) throw new Error('words ended early')
    return value
  }
  const take = (count: number): number[] => Array.from({ length: count }, next)
  const header = take(3)
  const definitions: DecodedDefinition[] = []
  for (let k = 0; k < (header[1] ?? 0); k += 1) {
    const [nameId = 0, flags = 0, plyEq = 0, plyMin = 0, plyMax = 0, bishop = 0, parent = 0, tier = 0] =
      take(8)
    const finishMoves = Array.from({ length: next() }, () => take(9))
    const placements = Array.from({ length: next() }, () => {
      const code = next()
      if (code === 6) {
        const [color = 0, mask = 0, count = 0] = take(3)
        return [code, color, mask, count, ...take(count * 2)]
      }
      const size = REQUIREMENT_WORDS[code]
      if (size === undefined) throw new Error(`unknown requirement code ${code}`)
      return [code, ...take(size)]
    })
    definitions.push({
      nameId,
      flags,
      ply: [plyEq, plyMin, plyMax],
      bishopExchange: bishop,
      gateParent: parent,
      tier,
      finishMoves,
      placements,
    })
  }
  if (at !== words.length) throw new Error(`${words.length - at} trailing words`)
  return { header, definitions }
}

describe('encodeDefinitions', () => {
  test('先頭は版・定義の数・名前の数。定義は nameId から順に並ぶ', () => {
    const words = encodeDefinitions([
      { name: '居玉形', placements: [new PiecePlacement(5, 9, PieceType.KING)] },
    ])
    expect([...words]).toEqual([
      FORMAT_VERSION, 1, 1,
      // nameId, flags, plyEq, plyMin, plyMax, bishopExchange, gateParent, tier
      0, 0, 0, 0, 0, 0, -1, 0,
      // 最終手 0 件、要件 1 件 (piece 5 9 玉 先手)
      0, 1, 1, 5, 9, 7, 0,
    ])
    expect(FORMAT_VERSION).toBe(1)
    expect([...encodeDefinitions([])]).toEqual([FORMAT_VERSION, 0, 0])
  })

  test('要件 11 種の番号と中身', () => {
    const placements: DefinitionRequirement[] = [
      new PiecePlacement(8, 2, PieceType.ROOK, Color.WHITE),
      new AnyOfPieces(4, 8, [PieceType.GOLD, PieceType.SILVER]),
      new EmptySquare(7, 7),
      new NotOfPieces(2, 2, [PieceType.BISHOP], Color.WHITE),
      new NotOfPieces(2, 8, [PieceType.ROOK, PieceType.DRAGON]),
      new AnyPiece(5, 7),
      new PieceInSquares(
        [
          { file: 7, rank: 8 },
          { file: 6, rank: 8 },
        ],
        [PieceType.GOLD, PieceType.SILVER],
      ),
      new PieceInSquares([{ file: 8, rank: 2 }], [PieceType.ROOK], Color.WHITE),
      new PieceAnywhere(PieceType.DRAGON),
      new HandPiece(PieceType.PAWN, 3),
      new HandPiece(PieceType.GOLD, -2),
      new PieceUnmoved(5, 9),
      new PieceVisited(6, 8, PieceType.KING),
      new KingIgyoku(),
    ]
    const words = body({ name: '全部', placements })
    expect(words.slice(0, 9)).toEqual([0, 0, 0, 0, 0, 0, -1, 0, 0])
    expect(words.slice(9)).toEqual([
      placements.length,
      ...[1, 8, 2, 6, 1],
      // 金 bit4 + 銀 bit3
      ...[2, 4, 8, 24],
      ...[3, 7, 7],
      // 角 bit5、相手
      ...[4, 2, 2, 32, 1],
      // 飛 bit6 + 龍 bit13
      ...[4, 2, 8, 64 | 8192, 0],
      ...[5, 5, 7],
      ...[6, 0, 24, 2, 7, 8, 6, 8],
      ...[6, 1, 64, 1, 8, 2],
      ...[7, 13],
      ...[8, 0, 3],
      ...[8, 4, -2],
      ...[9, 5, 9],
      ...[10, 6, 8, 7],
      ...[11],
    ])
  })

  test('flags と手数', () => {
    const flagsOf = (extra: Partial<FormationDefinition>): number[] =>
      body({ name: 'x', placements: [], ...extra }).slice(1, 5)
    expect(flagsOf({})).toEqual([0, 0, 0, 0])
    expect(flagsOf({ category: true })).toEqual([1, 0, 0, 0])
    expect(flagsOf({ evaluateAtGameEnd: true })).toEqual([2, 0, 0, 0])
    expect(flagsOf({ noDrop: true })).toEqual([4, 0, 0, 0])
    expect(flagsOf({ plyEq: 2 })).toEqual([8, 2, 0, 0])
    expect(flagsOf({ plyMin: 10, plyMax: 30 })).toEqual([48, 0, 10, 30])
    // 0 も「あり」。値が 0 でも flag で見分ける
    expect(flagsOf({ plyEq: 0 })).toEqual([8, 0, 0, 0])
    expect(flagsOf({ plyMin: 0 })).toEqual([16, 0, 0, 0])
    // false は立てない
    expect(flagsOf({ category: false, evaluateAtGameEnd: false, noDrop: false })).toEqual([0, 0, 0, 0])
    expect(
      flagsOf({ category: true, evaluateAtGameEnd: true, noDrop: true, plyEq: 1, plyMin: 2, plyMax: 3 }),
    ).toEqual([63, 1, 2, 3])
  })

  test('角交換の番号', () => {
    const code = (extra: Partial<FormationDefinition>): number | undefined =>
      body({ name: 'x', placements: [], ...extra })[5]
    expect(code({})).toBe(0)
    expect(code({ bishopExchange: 'self' })).toBe(1)
    expect(code({ bishopExchange: 'opponent' })).toBe(2)
    expect(code({ bishopExchange: 'any' })).toBe(3)
    expect(code({ bishopExchange: 'never' })).toBe(4)
  })

  test('最終手は 1 件 9 語', () => {
    const words = body({
      name: '最終手',
      finishMoves: [
        { from: { file: 8, rank: 8 }, to: { file: 2, rank: 2 }, promote: true },
        { to: { file: 5, rank: 5 }, drop: true },
        { to: { file: 7, rank: 6 }, capture: { kind: 'any' } },
        { to: { file: 2, rank: 6 }, capture: { kind: 'none' } },
        {
          to: { file: 5, rank: 5 },
          capture: { kind: 'pieces', pieces: [PieceType.BISHOP, PieceType.ROOK], negated: true },
        },
        { to: { file: 5, rank: 5 }, capture: { kind: 'pieces', pieces: [PieceType.HORSE], negated: false } },
        { to: { file: 7, rank: 6 } },
      ],
      placements: [],
    })
    expect(words.slice(8)).toEqual([
      7,
      // to, from, drop, promote, captureKind, negated, mask
      ...[2, 2, 8, 8, 0, 1, 0, 0, 0],
      ...[5, 5, 0, 0, 1, 0, 0, 0, 0],
      ...[7, 6, 0, 0, 0, 0, 1, 0, 0],
      ...[2, 6, 0, 0, 0, 0, 2, 0, 0],
      ...[5, 5, 0, 0, 0, 0, 3, 1, 96],
      ...[5, 5, 0, 0, 0, 0, 3, 0, 4096],
      ...[7, 6, 0, 0, 0, 0, 0, 0, 0],
      // 要件 0 件
      0,
    ])
  })

  test('同じ名前は同じ nameId。親ゲートの相手は nameId で、間の分類を飛ばす', () => {
    const definitions: FormationDefinition[] = [
      { name: '根', aliases: ['旧根'], placements: [new PiecePlacement(5, 9, PieceType.KING)] },
      { name: '分類', category: true, parent: '根', placements: [] },
      { name: '子', parent: '分類', placements: [new EmptySquare(5, 7)] },
      { name: '被り', placements: [new PiecePlacement(7, 7, PieceType.BISHOP)] },
      { name: '被り', priority: 1, placements: [new PiecePlacement(6, 6, PieceType.BISHOP)] },
      { name: '別名の子', parent: '旧根', placements: [] },
      { name: '被りの子', parent: '被り', placements: [] },
      { name: '迷子', parent: '居ない', placements: [] },
      { name: '甲', parent: '乙', placements: [] },
      { name: '乙', parent: '甲', placements: [] },
    ]
    const { header, definitions: decoded } = decode(encodeDefinitions(definitions))
    expect(header).toEqual([FORMAT_VERSION, 10, 9])
    expect(decoded.map((d) => d.nameId)).toEqual([0, 1, 2, 3, 3, 4, 5, 6, 7, 8])
    expect(decoded.map((d) => d.gateParent)).toEqual([-1, 0, 0, -1, -1, 0, 3, -1, 8, 7])
    expect(decoded.map((d) => d.tier)).toEqual(definitionOrderTiers(definitions))
  })

  test('作り物の定義も語が過不足なく読み戻せる', async () => {
    const { SYNTHETIC_DEFINITIONS, EDGE_DEFINITIONS } = await import('./synthetic-definitions.ts')
    const definitions = [...SYNTHETIC_DEFINITIONS, ...EDGE_DEFINITIONS]
    const { header, definitions: decoded } = decode(encodeDefinitions(definitions))
    expect(header[1]).toBe(definitions.length)
    expect(decoded.map((d) => d.placements.length)).toEqual(
      definitions.map((d) => d.placements.length),
    )
  })

  test('符号にできない定義は UnsupportedDefinitionError で断る', () => {
    const reject = (definition: FormationDefinition): void => {
      let caught: unknown
      try {
        encodeDefinitions([{ name: 'ok', placements: [] }, definition])
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(UnsupportedDefinitionError)
      expect((caught as UnsupportedDefinitionError).definition).toBe(definition)
    }
    // 同じ kind を名乗っても、知っているクラスでなければ断る
    const lookalike = {
      kind: 'piece',
      file: 5,
      rank: 9,
      pieceType: PieceType.KING,
      color: Color.BLACK,
      isSatisfiedBy: () => true,
    } as unknown as DefinitionRequirement
    reject({ name: '似せ物', placements: [lookalike] })
    reject({ name: '升の外', placements: [new PiecePlacement(0, 5, PieceType.PAWN)] })
    reject({ name: '升の外 2', placements: [new EmptySquare(5, 10)] })
    reject({ name: '組の升の外', placements: [new PieceInSquares([{ file: 10, rank: 1 }], [PieceType.GOLD])] })
    reject({ name: '知らない駒', placements: [new PieceAnywhere('queen' as PieceType)] })
    reject({ name: '端数の手数', plyMin: 1.5, placements: [] })
    reject({ name: '負の手数', plyEq: -1, placements: [] })
    reject({ name: '端数の枚数', placements: [new HandPiece(PieceType.PAWN, 0.5)] })
    reject({ name: '知らない角交換', bishopExchange: 'both' as 'any', placements: [] })
    reject({ name: '最終手の升の外', finishMoves: [{ to: { file: 5, rank: 0 } }], placements: [] })
    reject({
      name: '最終手の元の升の外',
      finishMoves: [{ from: { file: 10, rank: 5 }, to: { file: 5, rank: 5 } }],
      placements: [],
    })
    reject({
      name: '知らない取り方',
      finishMoves: [{ to: { file: 5, rank: 5 }, capture: { kind: 'some' } as unknown as { kind: 'any' } }],
      placements: [],
    })
    reject({ name: '知らない色', placements: [new PiecePlacement(5, 5, PieceType.PAWN, 'red' as Color)] })
  })
})

describe('encodeGames', () => {
  test('1 手 5 バイト。足りない所は 0、128 以上は 0x7f、6 文字目から先は捨てる', () => {
    const { moves, lengths } = encodeGames([
      ['7g7f', 'P*5e', '8h2b+', '7g7fX+extra', '７ｇ７ｆ', '', '7g7f😀'],
      [],
      ['resign'],
    ])
    expect([...lengths]).toEqual([7, 0, 1])
    const code = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
    expect([...moves]).toEqual([
      ...code('7g7f'), 0,
      ...code('P*5e'), 0,
      ...code('8h2b+'),
      ...code('7g7fX'),
      0x7f, 0x7f, 0x7f, 0x7f, 0,
      0, 0, 0, 0, 0,
      // 5 文字目はサロゲートの片割れ
      ...code('7g7f'), 0x7f,
      ...code('resig'),
    ])
  })
})

describe('optionBits', () => {
  test('3 つの options を bit に', () => {
    expect(optionBits({})).toBe(0)
    expect(optionBits({ moverOnly: true })).toBe(SCAN_BITS.moverOnly)
    expect(optionBits({ requireParent: true })).toBe(2)
    expect(optionBits({ suppressGameEndIfDetected: true })).toBe(4)
    expect(optionBits({ moverOnly: true, requireParent: true, suppressGameEndIfDetected: true })).toBe(7)
    expect(optionBits({ moverOnly: false, requireParent: false })).toBe(0)
    expect(SCAN_BITS).toEqual({
      moverOnly: 1,
      requireParent: 2,
      suppressGameEndIfDetected: 4,
      withDropped: 8,
      finalPosition: 16,
      naive: 32,
    })
  })
})

/**
 * WASM の代わりの exports。alloc は 1 から始まる積み上げで、わざと 4 の倍数に揃えない。
 * scan は渡された引数を控え、`respond` が返す語を揃っていない番地に書く。
 */
function fakeExports(respond: (games: number, options: number) => number[], status = 0) {
  const memory = new WebAssembly.Memory({ initial: 4 })
  let top = 1
  const live = new Map<number, number>()
  const scans: { moves: number[]; lengths: number[]; games: number; options: number }[] = []
  let out: { ptr: number; len: number } = { ptr: 0, len: 0 }
  const exports: ScannerExports = {
    memory,
    alloc(len) {
      const ptr = top
      top += len + 3
      live.set(ptr, len)
      return ptr
    },
    dealloc(ptr, len) {
      if (live.get(ptr) !== len) throw new Error(`dealloc(${ptr}, ${len}) does not match alloc`)
      live.delete(ptr)
    },
    compile: (_ptr, words) => (words >= 3 ? 7 : 0),
    release() {},
    scan(handle, movesPtr, movesLen, lensPtr, games, options) {
      expect(handle).toBe(7)
      const bytes = new Uint8Array(memory.buffer)
      const lens = bytes.slice(lensPtr, lensPtr + games * 4)
      scans.push({
        moves: [...bytes.slice(movesPtr, movesPtr + movesLen)],
        lengths: [...new Uint32Array(lens.buffer)],
        games,
        options,
      })
      const words = Int32Array.from(respond(games, options))
      const ptr = top + 1
      top = ptr + words.byteLength + 8
      bytes.set(new Uint8Array(words.buffer), ptr)
      out = { ptr, len: words.length }
      return status
    },
    out_ptr: () => out.ptr,
    out_len: () => out.len,
  }
  return { exports, scans, live }
}

describe('WasmScanner の包み (偽の exports)', () => {
  const a: FormationDefinition = { name: 'a', placements: [] }
  const b: FormationDefinition = { name: 'b', placements: [] }
  const dup: FormationDefinition = { name: 'a', priority: 1, placements: [] }
  const definitions = [a, b, dup]

  test('出力の組を渡したオブジェクトに戻す。確保した領域は全部返す', () => {
    const fake = fakeExports((games) =>
      games === 2 ? [3, 2, 0, 0, 1, 2, 1, 5, 0, 0] : [],
    )
    const compiled = new WasmScanner(fake.exports).compile(definitions)
    const result = compiled.recordMany([['7g7f', '3c3d', '2g2f'], []], { moverOnly: true })
    expect(result).toHaveLength(2)
    const first = result[0] ?? []
    expect(first[0]?.definition).toBe(a)
    expect(first[1]?.definition).toBe(dup)
    expect(first.map((d) => [d.side, d.ply])).toEqual([
      [Color.BLACK, 1],
      [Color.WHITE, 5],
    ])
    expect(result[1]).toEqual([])
    const scan = fake.scans[0]
    expect(scan?.games).toBe(2)
    expect(scan?.options).toBe(SCAN_BITS.moverOnly)
    expect(scan?.lengths).toEqual([3, 0])
    expect(scan?.moves).toHaveLength(15)
    expect(fake.live.size).toBe(0)
  })

  test('落ちた検出と最後の局面も読む', () => {
    const position = Array.from({ length: 96 }, (_, k) => k)
    const fake = fakeExports((_, options) =>
      (options & SCAN_BITS.finalPosition) !== 0
        ? [4, ...position, 1, 1, 1, 7, 1, 2, 0, 3]
        : [4, 0, 1, 2, 0, 3],
    )
    const compiled = new WasmScanner(fake.exports).compile(definitions)
    const bits = SCAN_BITS.withDropped | SCAN_BITS.finalPosition | SCAN_BITS.requireParent
    const [raw] = scanRaw(compiled, [['7g7f']], bits)
    expect(raw?.legalLength).toBe(4)
    expect(raw?.position?.cells).toEqual(position.slice(0, 81))
    expect(raw?.position?.blackHand).toEqual([81, 82, 83, 84, 85, 86, 87])
    expect(raw?.position?.whiteHand).toEqual([88, 89, 90, 91, 92, 93, 94])
    expect(raw?.position?.turn).toBe(95)
    expect(raw?.detections.map((d) => [d.definition, d.side, d.ply])).toEqual([[b, Color.WHITE, 7]])
    expect(raw?.dropped?.map((d) => [d.definition, d.side, d.ply])).toEqual([[dup, Color.BLACK, 3]])
    expect(fake.scans[0]?.options).toBe(bits)

    const withDropped = compiled.recordWithDropped(['7g7f'], { suppressGameEndIfDetected: true })
    expect(fake.scans[1]?.options).toBe(SCAN_BITS.withDropped | SCAN_BITS.suppressGameEndIfDetected)
    expect(withDropped.detections).toEqual([])
    expect(withDropped.dropped.map((d) => [d.definition, d.side, d.ply])).toEqual([[dup, Color.BLACK, 3]])
  })

  test('出力が壊れていれば投げる', () => {
    const run = (words: number[], status = 0): (() => unknown) => {
      const compiled = new WasmScanner(fakeExports(() => words, status).exports).compile(definitions)
      return () => compiled.record(['7g7f'])
    }
    expect(run([1, 0])).not.toThrow()
    expect(run([1, 0, 9])).toThrow('trailing')
    expect(run([1, 1, 0, 0])).toThrow('ended early')
    expect(run([1, 1, 3, 0, 1])).toThrow('unknown definition 3')
    expect(run([1, 1, -1, 0, 1])).toThrow('unknown definition -1')
    expect(run([1, 1, 0, 2, 1])).toThrow('unknown side 2')
    expect(run([1, 0], 3)).toThrow('status 3')
  })

  test('compile が 0 を返したら投げる。手放した後は使えない。initial は断る', () => {
    const fake = fakeExports(() => [0, 0])
    fake.exports.compile = () => 0
    expect(() => new WasmScanner(fake.exports).compile(definitions)).toThrow('rejected')
    expect(fake.live.size).toBe(0)

    const compiled = new WasmScanner(fakeExports(() => [0, 0]).exports).compile(definitions)
    expect(() => compiled.record([], { initial: {} } as never)).toThrow('initial')
    compiled.release()
    compiled.release()
    expect(() => compiled.record([])).toThrow('released')
  })

  test('扱えない定義は WASM に触る前に断る', () => {
    const fake = fakeExports(() => [])
    let compiled = 0
    fake.exports.compile = () => {
      compiled += 1
      return 7
    }
    const bad: FormationDefinition = { name: '升の外', placements: [new EmptySquare(0, 0)] }
    expect(() => new WasmScanner(fake.exports).compile([a, bad])).toThrow(UnsupportedDefinitionError)
    expect(compiled).toBe(0)
    expect(fake.live.size).toBe(0)
  })

  test('2000 局を超えたら分けて渡す', () => {
    const fake = fakeExports((games) => Array.from({ length: games }, () => [0, 0]).flat())
    const compiled = new WasmScanner(fake.exports).compile(definitions)
    const games = Array.from({ length: 4001 }, (_, k) => (k % 2 === 0 ? ['7g7f'] : []))
    expect(compiled.recordMany(games)).toHaveLength(4001)
    expect(fake.scans.map((scan) => scan.games)).toEqual([2000, 2000, 1])
    expect(fake.scans.map((scan) => scan.lengths.length)).toEqual([2000, 2000, 1])
    expect(fake.live.size).toBe(0)
  })
})
