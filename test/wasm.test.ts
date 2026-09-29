// WASM の走査器 (src/wasm/) と TS 版 (recordDefinitions / recordDefinitionsWithDropped) の突き合わせ。
// 定義・陣営・手数の列が 1 件の違いも無く一致すること、差分の走査 (既定) と毎手全部照らす
// 走査 (bit 32) のどちらでも同じになることを見る。最後の局面と合法な手の数は tsshogi で
// 指し直したものと比べる (bit 16)。
//
// src/wasm/scanner.gen.ts (bun run build:wasm で作る) が無い間はまとめて飛ばす。

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { Color, handPieceTypes, type Move, pieceTypes, Position, Square } from 'tsshogi'
import { KNOWN_CASTLES } from '../src/castle.ts'
import type { DetectedDefinitionAt, FormationDefinition } from '../src/definition.ts'
import { EmptySquare, PiecePlacement } from '../src/requirements.ts'
import { buildMoves, recordDefinitions, recordDefinitionsWithDropped } from '../src/scan.ts'
import { KNOWN_STRATEGIES } from '../src/strategy.ts'
import { optionBits, SCAN_BITS } from '../src/wasm/encode.ts'
import type { ScannedPosition, WasmScanOptions } from '../src/wasm/scanner.ts'
import { scanRaw } from '../src/wasm/scanner.ts'
import { randomGame, randomGames, seededRandom } from './random-games.ts'
import { EDGE_DEFINITIONS, SYNTHETIC_DEFINITIONS } from './synthetic-definitions.ts'

type WasmModule = typeof import('../src/wasm/index.ts')

const READY = existsSync(new URL('../src/wasm/scanner.gen.ts', import.meta.url))
// 生成物が無いときに読み込みを試みないよう、パスは変数で渡す
const ENTRY = '../src/wasm/index.ts'
const wasm: WasmModule | undefined = READY ? ((await import(ENTRY)) as WasmModule) : undefined
const scanner = wasm === undefined ? undefined : await wasm.loadScanner()

/** 実戦の序盤 (test/castle.test.ts・test/strategy.test.ts と同じ棋譜) */
const OPENINGS: readonly (readonly string[])[] = [
  '7g7f 3c3d 2g2f 5c5d 3i4h 5d5e 5i6h 8b5b 6h7h 5a6b 7i6h 6b7b 4i5h 7b8b 2f2e 2b3c 6h7g 5e5f 5g5f 5b5f 6g6f 5f5a 6f6e 3a4b 7g6f 4b5c 4h5g 7a7b 5h6g 5c5d'.split(
    ' ',
  ),
  '7g7f 3c3d 6g6f 8c8d 2h6h 8d8e 8h7g 7a6b 7i7h 6a5b 5i4h 5a4b 1g1f 4b3b 1f1e 5c5d 3i3h 3a4b 4h3i 4b5c 7h6g 7c7d 3i2h 7d7e 6h7h 7e7f 6g7f 8b7b 7g8h 5c6d'.split(
    ' ',
  ),
]

/** 手で組んだ端の棋譜 */
const FIXED_GAMES: readonly (readonly string[])[] = [
  [],
  ['resign'],
  // 角交換から打ち合い。最後の P*5d は二歩で止まる
  '7g7f 3c3d 8h2b+ 3a2b B*4e B*6e 4e6c+ 6e7f 6c5b 5a5b 7i7h 7f6g+ 7h6g P*5d'.split(' '),
  // 小文字の打ちは通る。最後の B*5e は持っていない角で止まる
  '7g7f 3c3d 8h2b+ 3a2b b*5e 4a3b 5e2b+ 3b2b B*5e'.split(' '),
  // 後手からの角交換
  '7g7f 3c3d 2g2f 2b8h+ 7i8h B*4e B*6e 4e3f 6e5d 3f2g+'.split(' '),
  // 持っていない玉を打つ手を tsshogi は通す
  ['K*5e', '3c3d'],
  ['7g7f+'],
  // 玉が一度動いて戻る (居玉・動かない駒)
  '7g7f 3c3d 5i5h 5a4b 5h5i 4b5a 5i5h'.split(' '),
  // 6 文字目から先は読まない
  ['7g7fXYZ', '3c3d+extra', '8h2b+!!'],
  ...OPENINGS,
]

/** 乱数の棋譜と、実戦の序盤から枝分かれさせた棋譜 */
function buildGames(): string[][] {
  const games = randomGames(20260928, 170, {
    plies: 120,
    brokenRate: 0.15,
    garbleRate: 0.003,
    kingDropRate: 0.01,
  })
  const random = seededRandom(918)
  for (const opening of OPENINGS) {
    for (const cut of [8, 14, 20, 26, 30]) {
      for (let k = 0; k < 4; k += 1) {
        games.push(
          randomGame(random, {
            plies: 100,
            prefix: opening.slice(0, cut),
            brokenRate: 0.1,
            garbleRate: 0.003,
            kingDropRate: 0.005,
          }),
        )
      }
    }
  }
  return [...FIXED_GAMES.map((game) => [...game]), ...games]
}

const GAMES = READY ? buildGames() : []

/** options の 3 つの bit の 8 通り */
const COMBOS: readonly WasmScanOptions[] = Array.from({ length: 8 }, (_, bits) => ({
  moverOnly: (bits & 1) !== 0,
  requireParent: (bits & 2) !== 0,
  suppressGameEndIfDetected: (bits & 4) !== 0,
}))

const label = (options: WasmScanOptions): string =>
  Object.entries(options)
    .filter(([, on]) => on === true)
    .map(([name]) => name)
    .join('+') || 'none'

/** tsshogi で指し直した局面を lib.rs の符号にする */
function encodePosition(moves: readonly Move[]): ScannedPosition {
  const position = new Position()
  for (const move of moves) {
    if (!position.doMove(move)) throw new Error(`replay failed at ${move.usi}`)
  }
  const cells = Array.from({ length: 81 }, (_, index) => {
    const piece = position.board.at(new Square(9 - (index % 9), Math.floor(index / 9) + 1))
    if (piece === null) return 0
    return ((piece.color === Color.BLACK ? 0 : 1) << 4) | (pieceTypes.indexOf(piece.type) + 1)
  })
  const hand = (color: Color): number[] =>
    handPieceTypes.map((type) => position.hand(color).count(type))
  return {
    cells,
    blackHand: hand(Color.BLACK),
    whiteHand: hand(Color.WHITE),
    turn: position.color === Color.BLACK ? 0 : 1,
  }
}

/**
 * 1 つの定義の集合と options で、全局を TS 版と走査器 (差分・毎手全部の両方) にかけて
 * 違いを文にして返す。長くなりすぎないよう先頭の 20 件まで
 */
function crossCheck(
  definitions: readonly FormationDefinition[],
  games: readonly (readonly string[])[],
  options: WasmScanOptions,
): string[] {
  if (scanner === undefined) throw new Error('scanner is not loaded')
  const indexOf = new Map(definitions.map((definition, index) => [definition, index] as const))
  const show = (list: readonly DetectedDefinitionAt[]): string[] =>
    list.map((d) => `${indexOf.get(d.definition)}:${d.definition.name}:${d.side}:${d.ply}`)
  const compiled = scanner.compile(definitions)
  try {
    const bits = optionBits(options) | SCAN_BITS.withDropped | SCAN_BITS.finalPosition
    const modes = [
      { name: 'incremental', raw: scanRaw(compiled, games, bits) },
      { name: 'naive', raw: scanRaw(compiled, games, bits | SCAN_BITS.naive) },
    ]
    const mismatches: string[] = []
    games.forEach((usis, g) => {
      const moves = buildMoves(usis)
      const expected = recordDefinitionsWithDropped(definitions, moves, options)
      const want = {
        legalLength: moves.length,
        position: encodePosition(moves),
        detections: show(expected.detections),
        dropped: show(expected.dropped),
      }
      for (const mode of modes) {
        const got = mode.raw[g]
        const actual = {
          legalLength: got?.legalLength,
          position: got?.position,
          detections: show(got?.detections ?? []),
          dropped: show(got?.dropped ?? []),
        }
        for (const key of ['legalLength', 'position', 'detections', 'dropped'] as const) {
          const a = JSON.stringify(want[key])
          const b = JSON.stringify(actual[key])
          if (a !== b && mismatches.length < 20) {
            mismatches.push(`game ${g} [${usis.join(' ')}] ${mode.name} ${key}: expected ${a} got ${b}`)
          }
        }
      }
    })
    return mismatches
  } finally {
    compiled.release()
  }
}

const SETS: readonly { readonly name: string; readonly definitions: readonly FormationDefinition[] }[] =
  [
    { name: 'KNOWN_CASTLES', definitions: KNOWN_CASTLES },
    { name: 'KNOWN_STRATEGIES', definitions: KNOWN_STRATEGIES },
    { name: '作り物', definitions: [...SYNTHETIC_DEFINITIONS, ...EDGE_DEFINITIONS] },
  ]

describe.skipIf(!READY)('WASM の走査器と TS 版の突き合わせ', () => {
  for (const set of SETS) {
    for (const options of COMBOS) {
      test(`${set.name} / ${label(options)}`, () => {
        expect(crossCheck(set.definitions, GAMES, options)).toEqual([])
      }, 60_000)
    }
  }

  // 囲い・戦法・作り物を 1 つの集合にする (名前の被り・別の集合の親を跨ぐ)
  const combined = [...KNOWN_CASTLES, ...KNOWN_STRATEGIES, ...SYNTHETIC_DEFINITIONS, ...EDGE_DEFINITIONS]
  for (const options of COMBOS) {
    test(`全部まとめて / ${label(options)}`, () => {
      expect(crossCheck(combined, GAMES.slice(0, 60), options)).toEqual([])
    }, 60_000)
  }
})

describe.skipIf(!READY)('WASM の公開の入口', () => {
  const games = READY ? buildGames().slice(0, 80) : []

  test('recordMany / record / recordWithDropped は TS 版と同じ定義オブジェクトを返す', () => {
    if (scanner === undefined) throw new Error('scanner is not loaded')
    const options = { moverOnly: true, requireParent: true }
    const compiled = scanner.compile(KNOWN_STRATEGIES)
    try {
      const many = compiled.recordMany(games, options)
      const manyWithDropped = compiled.recordManyWithDropped(games, options)
      games.forEach((usis, g) => {
        const moves = buildMoves(usis)
        const expected = recordDefinitionsWithDropped(KNOWN_STRATEGIES, moves, options)
        const same = (got: readonly DetectedDefinitionAt[], want: readonly DetectedDefinitionAt[]) => {
          expect(got.length).toBe(want.length)
          got.forEach((detected, k) => {
            expect(detected.definition).toBe(want[k]?.definition as FormationDefinition)
            expect(`${detected.side}:${detected.ply}`).toBe(`${want[k]?.side}:${want[k]?.ply}`)
          })
        }
        same(many[g] ?? [], recordDefinitions(KNOWN_STRATEGIES, moves, options))
        same(manyWithDropped[g]?.detections ?? [], expected.detections)
        same(manyWithDropped[g]?.dropped ?? [], expected.dropped)
        if (g % 10 === 0) {
          same(compiled.record(usis, options), expected.detections)
          const single = compiled.recordWithDropped(usis, options)
          same(single.detections, expected.detections)
          same(single.dropped, expected.dropped)
        }
      })
    } finally {
      compiled.release()
    }
  }, 60_000)

  test('2000 局を超える束も分けて回して局の順を保つ', () => {
    if (scanner === undefined) throw new Error('scanner is not loaded')
    const random = seededRandom(4242)
    const many = Array.from({ length: 2345 }, (_, k) => {
      const opening = OPENINGS[k % OPENINGS.length] ?? []
      const cut = Math.floor(random() * (opening.length + 1))
      return k % 7 === 0 ? [...opening.slice(0, cut), 'resign', ...opening.slice(cut)] : opening.slice(0, cut)
    })
    const options = { suppressGameEndIfDetected: true }
    const compiled = scanner.compile(KNOWN_CASTLES)
    try {
      const got = compiled.recordMany(many, options)
      expect(got).toHaveLength(many.length)
      const key = (list: readonly DetectedDefinitionAt[]) =>
        list.map((d) => `${d.definition.name}:${d.side}:${d.ply}`)
      const mismatched = many.filter(
        (usis, k) =>
          JSON.stringify(key(got[k] ?? [])) !==
          JSON.stringify(key(recordDefinitions(KNOWN_CASTLES, buildMoves(usis), options))),
      )
      expect(mismatched).toEqual([])
    } finally {
      compiled.release()
    }
  }, 60_000)

  test('定義が空でも回る', () => {
    if (scanner === undefined) throw new Error('scanner is not loaded')
    const compiled = scanner.compile([])
    try {
      expect(compiled.recordMany([[], ['7g7f'], ['resign']])).toEqual([[], [], []])
      const [raw] = scanRaw(compiled, [['7g7f', '3c3d', 'resign', '2g2f']], SCAN_BITS.finalPosition)
      expect(raw?.legalLength).toBe(2)
      expect(raw?.position).toEqual(encodePosition(buildMoves(['7g7f', '3c3d'])))
    } finally {
      compiled.release()
    }
  })

  test('loadScanner は同じ走査器を返す。扱えない定義と initial は断る', async () => {
    if (wasm === undefined || scanner === undefined) throw new Error('scanner is not loaded')
    expect(await wasm.loadScanner()).toBe(scanner)
    const bad: FormationDefinition = { name: '升の外', placements: [new EmptySquare(0, 5)] }
    expect(() => scanner.compile([bad])).toThrow(wasm.UnsupportedDefinitionError)
    const compiled = scanner.compile([
      { name: '歩', placements: [new PiecePlacement(7, 6, PieceTypePawn())] },
    ])
    expect(() => compiled.record([], { initial: new Position() } as WasmScanOptions)).toThrow('initial')
    compiled.release()
    expect(() => compiled.record([])).toThrow('released')
  })
})

/** pieceTypes の先頭 (歩)。PieceType の import を 1 箇所のためだけに増やさない */
function PieceTypePawn() {
  const pawn = pieceTypes[0]
  if (pawn === undefined) throw new Error('no piece types')
  return pawn
}
