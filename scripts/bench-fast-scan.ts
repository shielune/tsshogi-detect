// recordDefinitions の改良版 (ベンチ用の試作)。結果は元と同じになるように作ってある。
//
// 元の走査は毎手すべての定義を照らす。こちらは盤を整数の配列で持ち、升 1 つで言える
// 要件 (駒・空・任意の駒・候補・除外) を「升の中身の符号 → bit」の表引きにして、
// **その陣営が前に照らしてから中身の変わった升**に関わる定義だけを照らし直す。
// 変わった升は、相手の直前の手と自分の今の手で動いた升 (moverOnly 前提)。
//
// 升を見ただけでは真偽の変わり目を拾えない定義 (持駒・盤のどこか・居玉・手数・最終手・
// 角交換) は毎手照らす。手数の上限を過ぎたものはその局では外す。
//
// 元の走査は手ごとに 2 回照らしている。局面だけの照合 (detectDefinitions、履歴は
// PositionOnlyHistory の近似) と、本物の履歴での照合。前者に回る定義は、本物の履歴で
// 落ちたときに近似の履歴でも照らして、両者の和を取る。
//
// 升で拾えることの根拠: 本物の履歴の「通過した」は自分がその升へ指したときにしか真に
// ならず、「動いていない」は偽にしかならない。近似の履歴の「通過した」は平手の配置か
// 今の盤で決まり、「動いていない」と居玉は常に真。どれも索引に載せた升の変化で拾える。

import { Color, type Move, type Piece, type PieceType, pieceTypes, Position, Square } from 'tsshogi'
import type { DetectedDefinitionAt, FormationDefinition } from '../src/definition.ts'
import { dropUnestablishedChildren } from '../src/hierarchy.ts'
import {
  hasBishopExchangeConstraint,
  hasDropConstraint,
  hasFinishConstraint,
  hasPlyConstraint,
  matchesDefinition,
  matchesFinishMove,
} from '../src/match.ts'
import { MoveHistory } from '../src/move-history.ts'
import { orderDetectionsWithinPly } from '../src/order.ts'
import { positionOnlyHistory } from '../src/position-history.ts'
import {
  AnyOfPieces,
  AnyPiece,
  type DefinitionRequirement,
  EmptySquare,
  isHistoryRequirement,
  NotOfPieces,
  PieceInSquares,
  PiecePlacement,
  PieceUnmoved,
  PieceVisited,
} from '../src/requirements.ts'

export type FastScanOptions = {
  readonly moverOnly: true
  readonly requireParent?: boolean
  readonly suppressGameEndIfDetected?: boolean
}

const B = Color.BLACK
const W = Color.WHITE
const SIDES: readonly Color[] = [B, W]
const opposite = (side: Color): Color => (side === B ? W : B)

/** 駒種の番号 1..14。升の中身の符号は、空が 0、先手が 1..14、後手が 17..30 */
const TYPE_NO = new Map<PieceType, number>(pieceTypes.map((type, index) => [type, index + 1]))
const typeNo = (type: PieceType): number => TYPE_NO.get(type) ?? 0
const codeOf = (piece: Piece | null): number =>
  piece === null ? 0 : (piece.color === B ? 0 : 16) + typeNo(piece.type)
const bit = (color: Color, type: PieceType): number => 1 << ((color === B ? 0 : 16) + typeNo(type))
const bitsOf = (color: Color, types: readonly PieceType[]): number =>
  types.reduce((mask, type) => mask | bit(color, type), 0)
const EMPTY_BIT = 1

/** 定義視点の升を、その陣営から見た盤の添字 (Square.index) に */
const indexOf = (file: number, rank: number, side: Color): number =>
  side === B ? (rank - 1) * 9 + (9 - file) : (9 - rank) * 9 + (file - 1)

/** 定義視点の絶対色 (BLACK が自陣) を、照らす陣営から見た実際の色に */
const actual = (color: Color, side: Color): Color => (color === B ? side : opposite(side))

type Plan = {
  readonly definition: FormationDefinition
  /** 升 1 つで言える要件の升と、その升に許す中身の bit */
  readonly squares: Int8Array
  readonly masks: Int32Array
  /** 表引きにできなかった要件。要件の isSatisfiedBy で照らす */
  readonly rest: readonly DefinitionRequirement[]
  /** 近似の履歴でも照らす (元の detectDefinitions に回る定義で、履歴要件を持つもの) */
  readonly approximate: boolean
  /** 毎手照らす */
  readonly volatile: boolean
  /** 変われば照らし直す升 (volatile なら使わない) */
  readonly watched: readonly number[]
  readonly finishTo: ReadonlySet<number> | null
  readonly plyLo: number
  readonly plyHi: number
  /** 打ち・角交換の縛りがあるので、最後に matchesDefinition で照らし直す */
  readonly post: boolean
}

function plan(definition: FormationDefinition, side: Color): Plan {
  const squares: number[] = []
  const masks: number[] = []
  const rest: DefinitionRequirement[] = []
  const watched = new Set<number>()
  let volatile =
    hasPlyConstraint(definition) ||
    hasFinishConstraint(definition) ||
    hasBishopExchangeConstraint(definition)
  const cell = (file: number, rank: number, mask: number): void => {
    const square = indexOf(file, rank, side)
    squares.push(square)
    masks.push(mask)
    watched.add(square)
  }
  for (const requirement of definition.placements) {
    if (requirement instanceof PiecePlacement) {
      cell(requirement.file, requirement.rank, bit(actual(requirement.color, side), requirement.pieceType))
    } else if (requirement instanceof EmptySquare) {
      cell(requirement.file, requirement.rank, EMPTY_BIT)
    } else if (requirement instanceof AnyPiece) {
      cell(requirement.file, requirement.rank, bitsOf(side, pieceTypes))
    } else if (requirement instanceof AnyOfPieces) {
      cell(requirement.file, requirement.rank, bitsOf(side, requirement.options))
    } else if (requirement instanceof NotOfPieces) {
      cell(requirement.file, requirement.rank, ~bitsOf(actual(requirement.color, side), requirement.excluded))
    } else {
      rest.push(requirement)
      if (requirement instanceof PieceVisited || requirement instanceof PieceUnmoved) {
        watched.add(indexOf(requirement.file, requirement.rank, side))
      } else if (requirement instanceof PieceInSquares) {
        for (const square of requirement.squares) watched.add(indexOf(square.file, square.rank, side))
      } else {
        // 持駒・盤のどこか・居玉は升で拾えない
        volatile = true
      }
    }
  }
  const positional =
    !hasPlyConstraint(definition) &&
    !hasDropConstraint(definition) &&
    !hasFinishConstraint(definition) &&
    !hasBishopExchangeConstraint(definition)
  return {
    definition,
    squares: Int8Array.from(squares),
    masks: Int32Array.from(masks),
    rest,
    approximate: positional && rest.some(isHistoryRequirement),
    volatile,
    watched: [...watched],
    finishTo: hasFinishConstraint(definition)
      ? new Set((definition.finishMoves ?? []).map((move) => indexOf(move.to.file, move.to.rank, side)))
      : null,
    // satisfiesPlyConstraint と同じく、ある縛りはすべて満たすこと
    plyLo: Math.max(definition.plyEq ?? 0, definition.plyMin ?? 0),
    plyHi: Math.min(
      definition.plyEq ?? Number.POSITIVE_INFINITY,
      definition.plyMax ?? Number.POSITIVE_INFINITY,
    ),
    post: definition.noDrop === true || definition.bishopExchange !== undefined,
  }
}

type SidePlans = {
  readonly plans: readonly Plan[]
  /** 升の添字 → その升を見ている (volatile でない) 定義の添字 */
  readonly bySquare: readonly (readonly number[])[]
  readonly volatile: readonly number[]
}

export type FastScanner = {
  readonly definitions: readonly FormationDefinition[]
  readonly black: SidePlans
  readonly white: SidePlans
  readonly gameEnd: readonly FormationDefinition[]
}

export function compileFastScanner(definitions: readonly FormationDefinition[]): FastScanner {
  const live = definitions.filter(
    (definition) => definition.category !== true && definition.evaluateAtGameEnd !== true,
  )
  const names = new Set(live.map((definition) => definition.name))
  // 元は (名前, 陣営) で 1 度きりにする。こちらは定義ごとなので、名前が重なると食い違う
  if (names.size !== live.length) throw new Error('同じ名前の定義がある')
  const sidePlans = (side: Color): SidePlans => {
    const plans = live.map((definition) => plan(definition, side))
    const bySquare: number[][] = Array.from({ length: 81 }, () => [])
    const volatile: number[] = []
    plans.forEach((p, index) => {
      if (p.volatile) volatile.push(index)
      else for (const square of p.watched) bySquare[square]?.push(index)
    })
    return { plans, bySquare, volatile }
  }
  return {
    definitions,
    black: sidePlans(B),
    white: sidePlans(W),
    gameEnd: definitions.filter((definition) => definition.evaluateAtGameEnd === true),
  }
}

/** recordDefinitions (moverOnly) と同じ結果を返す */
export function recordDefinitionsFast(
  scanner: FastScanner,
  moves: readonly Move[],
  options: FastScanOptions,
): DetectedDefinitionAt[] {
  const position = new Position()
  const history = new MoveHistory()
  history.initFromPosition(position)
  const board = (position.board as unknown as { readonly squares: readonly (Piece | null)[] }).squares
  const codes = Int8Array.from(board, codeOf)
  const count = scanner.black.plans.length
  const seen = { [B]: new Uint8Array(count), [W]: new Uint8Array(count) }
  const stamp = new Int32Array(count)
  const volatile = { [B]: [...scanner.black.volatile], [W]: [...scanner.white.volatile] }
  const started = { [B]: false, [W]: false }
  const results: DetectedDefinitionAt[] = []

  const hit = (p: Plan, side: Color, index: number, ply: number, move: Move): void => {
    const done = seen[side]
    if (done[index] === 1) return
    if (ply < p.plyLo || ply > p.plyHi) return
    if (p.finishTo !== null) {
      if (!p.finishTo.has(move.to.index) || !matchesFinishMove(p.definition, side, move)) return
    }
    const { squares, masks } = p
    for (let k = 0; k < squares.length; k++) {
      if (((masks[k] ?? 0) & (1 << (codes[squares[k] ?? 0] ?? 0))) === 0) return
    }
    if (!p.rest.every((requirement) => requirement.isSatisfiedBy(position, side, history))) {
      if (!p.approximate) return
      const approximate = positionOnlyHistory(position)
      if (!p.rest.every((requirement) => requirement.isSatisfiedBy(position, side, approximate))) return
    }
    if (p.post && !matchesDefinition(position, p.definition, side, history)) return
    done[index] = 1
    results.push({ definition: p.definition, side, ply })
  }

  let previous: readonly number[] = []
  for (let t = 0; t < moves.length; t++) {
    const move = moves[t] as Move
    const ply = t + 1
    const side = move.color
    history.recordMove(move, ply)
    position.doMove(move, { ignoreValidation: true })
    const touched = move.from instanceof Square ? [move.to.index, move.from.index] : [move.to.index]
    for (const square of touched) codes[square] = codeOf(board[square] ?? null)
    const { plans, bySquare } = side === B ? scanner.black : scanner.white
    if (!started[side]) {
      // その陣営の最初の手は全部照らす
      started[side] = true
      for (let index = 0; index < count; index++) hit(plans[index] as Plan, side, index, ply, move)
    } else {
      const list = volatile[side]
      let kept = 0
      for (const index of list) {
        const p = plans[index] as Plan
        if (ply > p.plyHi) continue
        list[kept++] = index
        hit(p, side, index, ply, move)
      }
      list.length = kept
      for (const square of [...previous, ...touched]) {
        for (const index of bySquare[square] ?? []) {
          if (stamp[index] === ply) continue
          stamp[index] = ply
          hit(plans[index] as Plan, side, index, ply, move)
        }
      }
    }
    previous = touched
  }

  if (moves.length > 0) {
    const detectedSides = new Set(results.map((detected) => detected.side))
    const done = new Set(results.map((detected) => `${detected.definition.name}|${detected.side}`))
    for (const definition of scanner.gameEnd) {
      for (const side of SIDES) {
        if (options.suppressGameEndIfDetected === true && detectedSides.has(side)) continue
        if (done.has(`${definition.name}|${side}`)) continue
        if (!matchesDefinition(position, definition, side, history)) continue
        done.add(`${definition.name}|${side}`)
        results.push({ definition, side, ply: history.outbreakTurn ?? moves.length })
      }
    }
  }
  const gated =
    options.requireParent === true ? dropUnestablishedChildren(results, scanner.definitions) : results
  return orderDetectionsWithinPly(gated, scanner.definitions)
}

/** 何を毎手照らしているかの内訳 (報告用) */
export function describeFastScanner(scanner: FastScanner): string {
  const { plans, volatile } = scanner.black
  const approximate = plans.filter((p) => p.approximate).length
  return (
    `定義 ${plans.length} (毎手照らす ${volatile.length}, 近似の履歴でも照らす ${approximate}),` +
    ` 終局で照らす ${scanner.gameEnd.length}`
  )
}
