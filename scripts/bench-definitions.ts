// ベンチで使う定義を、アプリ (mito-shogi) の dev サーバから取って走査できる形に組む。
//
// アプリの registry.ts の toSourceEntries と build.ts の buildDefinition を、この
// リポジトリのパーサで写したもの。行は scripts/.cache/definitions.json に控え、
// 次からはサーバが落ちていてもそれを読む (控えはコミットしない)。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Color, type PieceType } from 'tsshogi'
import type { FormationDefinition } from '../src/definition.ts'
import { type ParsedDefinition, parseDefinitionFile, type PlacementCell } from '../src/parser.ts'
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

const SOURCE = 'http://localhost:11475/api/formations/definitions'
const CACHE = join(import.meta.dirname, '.cache', 'definitions.json')

type Row = { readonly kind: string; readonly name: string; readonly dsl: string }

export type BenchDefinitions = {
  readonly castles: FormationDefinition[]
  readonly strategies: FormationDefinition[]
  /** サーバの行の数 (壊れていて捨てた行も含む) */
  readonly rows: number
}

function soloPiece(placement: PlacementCell): PieceType {
  const piece = placement.pieceTypes[0]
  if (piece === undefined) throw new Error(`${placement.kind} に駒種が無い`)
  return piece
}

function buildRequirement(placement: PlacementCell): DefinitionRequirement {
  const { file, rank } = placement
  switch (placement.kind) {
    case 'exact':
      return new PiecePlacement(file, rank, soloPiece(placement))
    case 'opponent':
      return new PiecePlacement(file, rank, soloPiece(placement), Color.WHITE)
    case 'anyOf':
      return new AnyOfPieces(file, rank, placement.pieceTypes)
    case 'notOf':
      return new NotOfPieces(file, rank, placement.pieceTypes)
    case 'opponentNotOf':
      return new NotOfPieces(file, rank, placement.pieceTypes, Color.WHITE)
    case 'empty':
      return new EmptySquare(file, rank)
    case 'anyPiece':
      return new AnyPiece(file, rank)
    case 'pieceAnywhere':
      return new PieceAnywhere(soloPiece(placement))
    case 'handPiece':
      return new HandPiece(soloPiece(placement), placement.minCount)
    case 'pieceUnmoved':
      return new PieceUnmoved(file, rank)
    case 'pieceVisited':
      return new PieceVisited(file, rank, soloPiece(placement))
    case 'kingIgyoku':
      return new KingIgyoku()
    case 'pieceInSquares':
      return new PieceInSquares(placement.squares, placement.pieceTypes)
    case 'opponentInSquares':
      return new PieceInSquares(placement.squares, placement.pieceTypes, Color.WHITE)
  }
}

function buildDefinition(parsed: ParsedDefinition): FormationDefinition {
  return {
    name: parsed.name,
    ...(parsed.aliases.length > 0 ? { aliases: parsed.aliases } : {}),
    ...(parsed.parent !== null ? { parent: parsed.parent } : {}),
    ...(parsed.side !== null ? { side: parsed.side } : {}),
    ...(parsed.category ? { category: true } : {}),
    ...(parsed.plyEq !== null ? { plyEq: parsed.plyEq } : {}),
    ...(parsed.plyMin !== null ? { plyMin: parsed.plyMin } : {}),
    ...(parsed.plyMax !== null ? { plyMax: parsed.plyMax } : {}),
    ...(parsed.evaluateAtGameEnd ? { evaluateAtGameEnd: true } : {}),
    ...(parsed.priority !== null ? { priority: parsed.priority } : {}),
    ...(parsed.noDrop ? { noDrop: true } : {}),
    ...(parsed.bishopExchange !== null ? { bishopExchange: parsed.bishopExchange } : {}),
    ...(parsed.finishMoves.length > 0
      ? {
          finishMoves: parsed.finishMoves.map((move) => ({
            ...(move.from === null ? {} : { from: move.from }),
            to: move.to,
            ...(move.capture === null ? {} : { capture: move.capture }),
            ...(move.promote ? { promote: true } : {}),
            ...(move.drop ? { drop: true } : {}),
          })),
        }
      : {}),
    placements: parsed.placements.map(buildRequirement),
  }
}

/** 1 行を定義に。種別が違う・名前が合わない・読めない行は捨てる (toSourceEntry と同じ) */
function toDefinition(row: Row): FormationDefinition | null {
  if (row.kind !== 'castle' && row.kind !== 'strategy') return null
  try {
    const parsed = parseDefinitionFile(row.dsl)
    const first = parsed[0]
    if (parsed.length !== 1 || first === undefined || first.name !== row.name) return null
    return buildDefinition(first)
  } catch {
    return null
  }
}

async function fetchRows(cacheOnly: boolean): Promise<Row[]> {
  if (cacheOnly) return JSON.parse(readFileSync(CACHE, 'utf8')) as Row[]
  try {
    const response = await fetch(SOURCE)
    if (!response.ok) throw new Error(`${response.status}`)
    const { definitions } = (await response.json()) as { definitions: Row[] }
    mkdirSync(dirname(CACHE), { recursive: true })
    writeFileSync(CACHE, JSON.stringify(definitions))
    return definitions
  } catch (error) {
    if (!existsSync(CACHE)) throw new Error(`${SOURCE} から定義を取れず、控えも無い: ${error}`)
    return JSON.parse(readFileSync(CACHE, 'utf8')) as Row[]
  }
}

/**
 * `cacheOnly` のときはサーバに聞かず控えだけを読む (同じ回の中で定義を揃えたいとき)。
 * 控えが無ければ投げる。
 */
export async function loadBenchDefinitions(cacheOnly = false): Promise<BenchDefinitions> {
  const rows = await fetchRows(cacheOnly)
  const castles: FormationDefinition[] = []
  const strategies: FormationDefinition[] = []
  for (const row of rows) {
    const definition = toDefinition(row)
    if (definition === null) continue
    ;(row.kind === 'castle' ? castles : strategies).push(definition)
  }
  return { castles, strategies, rows: rows.length }
}
