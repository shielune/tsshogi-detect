/**
 * WASM の走査器 (rust/) へ渡す整数列を作る。取り決めは rust/src/lib.rs の冒頭の文書がすべてで、
 * ここはその「定義の符号」と「棋譜の符号」をそのまま書き起こしたもの。
 *
 * 符号にできない定義 (知らない要件・範囲外の升・整数でない手数など) は
 * UnsupportedDefinitionError で断る。呼ぶ側はそれを見て TS 版の走査へ戻す。
 */

import { Color, PieceType, pieceTypes } from 'tsshogi'
import type { BishopExchange, DefinitionFinishMove, FormationDefinition } from '../definition.ts'
import { gateParents } from '../hierarchy.ts'
import { definitionOrderTiers } from '../order.ts'
import {
  AnyOfPieces,
  AnyPiece,
  type DefinitionRequirement,
  type DefinitionSquare,
  EmptySquare,
  HandPiece,
  KingIgyoku,
  NotOfPieces,
  PieceAnywhere,
  PieceInSquares,
  PiecePlacement,
  PieceUnmoved,
  PieceVisited,
} from '../requirements.ts'

/** 定義の符号の版。rust/src/lib.rs の FORMAT_VERSION と揃える。 */
export const FORMAT_VERSION = 1

/** 走査の options の bit (lib.rs の「options の bit」)。 */
export const SCAN_BITS = {
  moverOnly: 1,
  requireParent: 2,
  suppressGameEndIfDetected: 4,
  withDropped: 8,
  finalPosition: 16,
  naive: 32,
} as const

/** 棋譜の符号で指し手 1 つに使うバイト数。 */
export const MOVE_BYTES = 5

/** WASM の走査器では扱えない定義。呼ぶ側は TS 版の走査へ戻す。 */
export class UnsupportedDefinitionError extends Error {
  readonly definition: FormationDefinition

  constructor(definition: FormationDefinition, reason: string) {
    super(`definition "${definition.name}" cannot be scanned by the WASM scanner: ${reason}`)
    this.name = 'UnsupportedDefinitionError'
    this.definition = definition
  }
}

/** 要件の種別の番号 (lib.rs の表)。 */
const REQUIREMENT_CODE = {
  piece: 1,
  anyOf: 2,
  empty: 3,
  notOf: 4,
  anyPiece: 5,
  pieceInSquares: 6,
  anywhere: 7,
  hand: 8,
  unmoved: 9,
  visited: 10,
  igyoku: 11,
} as const

const BISHOP_EXCHANGE_CODE: Readonly<Record<BishopExchange, number>> = {
  self: 1,
  opponent: 2,
  any: 3,
  never: 4,
}

const PIECE_INDEX: ReadonlyMap<PieceType, number> = new Map(
  pieceTypes.map((type, index) => [type, index] as const),
)

const I32_MAX = 0x7fffffff

/**
 * 定義の列を符号にする。並び順・同じ名前の扱い・親ゲートの相手・同じ手数での順位は
 * すべてここで決めて渡す (走査器は名前を知らない)。
 */
export function encodeDefinitions(definitions: readonly FormationDefinition[]): Int32Array {
  const nameIds = new Map<string, number>()
  for (const definition of definitions) {
    if (!nameIds.has(definition.name)) nameIds.set(definition.name, nameIds.size)
  }
  const parents = gateParents(definitions)
  const tiers = definitionOrderTiers(definitions)
  const words: number[] = [FORMAT_VERSION, definitions.length, nameIds.size]
  definitions.forEach((definition, index) => {
    const reject = (reason: string): never => {
      throw new UnsupportedDefinitionError(definition, reason)
    }
    const int = (value: number, what: string, min = 0): number => {
      if (!Number.isInteger(value) || value < min || value > I32_MAX) reject(`${what} is ${value}`)
      return value
    }
    const coord = (value: number, what: string): number => {
      if (!Number.isInteger(value) || value < 1 || value > 9) reject(`${what} is ${value}`)
      return value
    }
    const piece = (type: PieceType): number => {
      const code = PIECE_INDEX.get(type)
      return code === undefined ? reject(`unknown piece type ${String(type)}`) : code
    }
    const mask = (types: readonly PieceType[]): number =>
      types.reduce((bits, type) => bits | (1 << piece(type)), 0)
    const color = (value: Color): number => {
      if (value === Color.BLACK) return 0
      return value === Color.WHITE ? 1 : reject(`unknown color ${String(value)}`)
    }
    const square = (value: DefinitionSquare, what: string): number[] => [
      coord(value.file, `${what} file`),
      coord(value.rank, `${what} rank`),
    ]

    const parent = parents[index]
    const tier = tiers[index] ?? 0
    words.push(
      nameIds.get(definition.name) ?? 0,
      flagsOf(definition),
      definition.plyEq === undefined ? 0 : int(definition.plyEq, 'plyEq'),
      definition.plyMin === undefined ? 0 : int(definition.plyMin, 'plyMin'),
      definition.plyMax === undefined ? 0 : int(definition.plyMax, 'plyMax'),
      definition.bishopExchange === undefined
        ? 0
        : (BISHOP_EXCHANGE_CODE[definition.bishopExchange] ??
            reject(`unknown bishop_exchange ${String(definition.bishopExchange)}`)),
      parent === undefined ? -1 : (nameIds.get(parent.name) ?? -1),
      tier,
    )

    const finishMoves: readonly DefinitionFinishMove[] = definition.finishMoves ?? []
    words.push(finishMoves.length)
    for (const entry of finishMoves) {
      const capture = entry.capture
      let captureKind = 0
      let negated = 0
      let pieces = 0
      if (capture !== undefined) {
        switch (capture.kind) {
          case 'any':
            captureKind = 1
            break
          case 'none':
            captureKind = 2
            break
          case 'pieces':
            captureKind = 3
            negated = capture.negated ? 1 : 0
            pieces = mask(capture.pieces)
            break
          default:
            reject(`unknown finish capture ${String((capture as { kind: unknown }).kind)}`)
        }
      }
      words.push(
        ...square(entry.to, 'finish to'),
        ...(entry.from === undefined ? [0, 0] : square(entry.from, 'finish from')),
        entry.drop === true ? 1 : 0,
        entry.promote === true ? 1 : 0,
        captureKind,
        negated,
        pieces,
      )
    }

    words.push(definition.placements.length)
    for (const requirement of definition.placements) {
      words.push(...encodeRequirement(requirement, { reject, int, coord, piece, mask, color, square }))
    }
  })
  return Int32Array.from(words)
}

type Encoders = {
  readonly reject: (reason: string) => never
  readonly int: (value: number, what: string, min?: number) => number
  readonly coord: (value: number, what: string) => number
  readonly piece: (type: PieceType) => number
  readonly mask: (types: readonly PieceType[]) => number
  readonly color: (value: Color) => number
  readonly square: (value: DefinitionSquare, what: string) => number[]
}

/**
 * 要件 1 件。種別の文字列ではなくクラスで見分ける — 同じ `kind` を名乗る別の実装は
 * 照合の中身が違うかもしれないので、知っているクラス以外は断る。
 */
function encodeRequirement(requirement: DefinitionRequirement, e: Encoders): number[] {
  const at = (file: number, rank: number): number[] => [e.coord(file, 'file'), e.coord(rank, 'rank')]
  if (requirement instanceof PiecePlacement) {
    return [
      REQUIREMENT_CODE.piece,
      ...at(requirement.file, requirement.rank),
      e.piece(requirement.pieceType),
      e.color(requirement.color),
    ]
  }
  if (requirement instanceof AnyOfPieces) {
    return [REQUIREMENT_CODE.anyOf, ...at(requirement.file, requirement.rank), e.mask(requirement.options)]
  }
  if (requirement instanceof EmptySquare) {
    return [REQUIREMENT_CODE.empty, ...at(requirement.file, requirement.rank)]
  }
  if (requirement instanceof NotOfPieces) {
    return [
      REQUIREMENT_CODE.notOf,
      ...at(requirement.file, requirement.rank),
      e.mask(requirement.excluded),
      e.color(requirement.color),
    ]
  }
  if (requirement instanceof AnyPiece) {
    return [REQUIREMENT_CODE.anyPiece, ...at(requirement.file, requirement.rank)]
  }
  if (requirement instanceof PieceInSquares) {
    return [
      REQUIREMENT_CODE.pieceInSquares,
      e.color(requirement.color),
      e.mask(requirement.options),
      requirement.squares.length,
      ...requirement.squares.flatMap((square) => e.square(square, 'square')),
    ]
  }
  if (requirement instanceof PieceAnywhere) {
    return [REQUIREMENT_CODE.anywhere, e.piece(requirement.pieceType)]
  }
  if (requirement instanceof HandPiece) {
    // 枚数は負でも書ける (0 以上なら常に真)。整数でなければ比べ方が変わるので断る
    return [
      REQUIREMENT_CODE.hand,
      e.piece(requirement.pieceType),
      e.int(requirement.minCount, 'hand minCount', -I32_MAX),
    ]
  }
  if (requirement instanceof PieceUnmoved) {
    return [REQUIREMENT_CODE.unmoved, ...at(requirement.file, requirement.rank)]
  }
  if (requirement instanceof PieceVisited) {
    return [
      REQUIREMENT_CODE.visited,
      ...at(requirement.file, requirement.rank),
      e.piece(requirement.pieceType),
    ]
  }
  if (requirement instanceof KingIgyoku) return [REQUIREMENT_CODE.igyoku]
  return e.reject(`unknown requirement kind "${requirement.kind}"`)
}

function flagsOf(definition: FormationDefinition): number {
  let flags = 0
  if (definition.category === true) flags |= 1
  if (definition.evaluateAtGameEnd === true) flags |= 2
  if (definition.noDrop === true) flags |= 4
  if (definition.plyEq !== undefined) flags |= 8
  if (definition.plyMin !== undefined) flags |= 16
  if (definition.plyMax !== undefined) flags |= 32
  return flags
}

/**
 * 棋譜の列を符号にする。指し手 1 つを 5 バイト (USI の先頭 5 文字の文字コード、足りない所は 0、
 * 128 以上は 0x7f)、局ごとの手数を別の u32 の列に。
 */
export function encodeGames(games: readonly (readonly string[])[]): {
  readonly moves: Uint8Array
  readonly lengths: Uint32Array
} {
  let total = 0
  for (const game of games) total += game.length
  const moves = new Uint8Array(total * MOVE_BYTES)
  const lengths = new Uint32Array(games.length)
  let offset = 0
  games.forEach((game, index) => {
    lengths[index] = game.length
    for (const usi of game) {
      const n = Math.min(usi.length, MOVE_BYTES)
      for (let k = 0; k < n; k += 1) {
        const code = usi.charCodeAt(k)
        moves[offset + k] = code >= 0x80 ? 0x7f : code
      }
      offset += MOVE_BYTES
    }
  })
  return { moves, lengths }
}

/** 走査の options を bit に。 */
export function optionBits(options: {
  readonly moverOnly?: boolean
  readonly requireParent?: boolean
  readonly suppressGameEndIfDetected?: boolean
}): number {
  let bits = 0
  if (options.moverOnly === true) bits |= SCAN_BITS.moverOnly
  if (options.requireParent === true) bits |= SCAN_BITS.requireParent
  if (options.suppressGameEndIfDetected === true) bits |= SCAN_BITS.suppressGameEndIfDetected
  return bits
}
