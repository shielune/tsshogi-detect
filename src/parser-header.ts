// 定義 DSL のヘッダ行 (`parent:` `side:` `ply:` `board:` …) の解析と、
// パース中の 1 セクションが持つ状態。parser.ts の分割の一部。

import type { PieceType } from 'tsshogi'
import { cell, isDigits, type ParsedFinishMove, type PlacementCell, DefinitionSyntaxError } from './parser-types.ts'
import { pieceTypeOf } from './parser-cell-token.ts'
import { parseFinishHeader } from './parser-finish.ts'
import type { BishopExchange, FormationSide } from './definition.ts'

function parseHeaderLine(line: string, lineNo: number): { key: string; value: string } {
  const idx = line.indexOf(':')
  if (idx < 0) {
    throw new DefinitionSyntaxError(`expected "key: value", got "${line}"`, lineNo)
  }
  const key = line.slice(0, idx).trim()
  const value = line.slice(idx + 1).trim()
  if (key === '') {
    throw new DefinitionSyntaxError(`empty key in "${line}"`, lineNo)
  }
  return { key, value }
}

/** `3` → eq=3 / `max 10` → max=10 / `min 5, max 10` → 下限と上限。 */
function parsePlyHeader(
  value: string,
  lineNo: number,
): { eq: number | null; min: number | null; max: number | null } {
  const result: { eq: number | null; min: number | null; max: number | null } = {
    eq: null,
    min: null,
    max: null,
  }
  for (const rawPart of value.split(',')) {
    const part = rawPart.trim()
    if (part === '') continue
    if (part.startsWith('max')) {
      const num = part.slice(3).trim()
      if (!isDigits(num)) {
        throw new DefinitionSyntaxError(`invalid ply max value "${part}"`, lineNo)
      }
      result.max = Number(num)
    } else if (part.startsWith('min')) {
      const num = part.slice(3).trim()
      if (!isDigits(num)) {
        throw new DefinitionSyntaxError(`invalid ply min value "${part}"`, lineNo)
      }
      result.min = Number(num)
    } else {
      if (!isDigits(part)) {
        throw new DefinitionSyntaxError(`invalid ply eq value "${part}"`, lineNo)
      }
      result.eq = Number(part)
    }
  }
  return result
}

/**
 * `priority: 100` / `priority: -10`。前に出したい度合いなので負の数も書ける
 * (`isDigits` は符号を通さないので、先頭の `-` を切ってから数字を見る)。
 */
function parsePriorityHeader(value: string, lineNo: number): number {
  const trimmed = value.trim()
  const digits = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed
  if (!isDigits(digits)) {
    throw new DefinitionSyntaxError(`priority must be an integer, got "${value}"`, lineNo)
  }
  return Number(trimmed)
}

/** `K 5 9` 形式を (駒種, file, rank) に分解する。 */
function parseCoordHeader(
  value: string,
  lineNo: number,
  key: string,
): { piece: PieceType; file: number; rank: number } {
  const [pieceToken, fileToken, rankToken, ...rest] = value
    .split(/\s+/)
    .filter((token) => token !== '')
  if (
    pieceToken === undefined ||
    fileToken === undefined ||
    rankToken === undefined ||
    rest.length > 0
  ) {
    throw new DefinitionSyntaxError(
      `expected "${key}: <piece> <file> <rank>", got "${value}"`,
      lineNo,
    )
  }
  const piece = pieceTypeOf(pieceToken, lineNo)
  if (!isDigits(fileToken) || !isDigits(rankToken)) {
    throw new DefinitionSyntaxError(`invalid coordinates in "${key}: ${value}"`, lineNo)
  }
  const file = Number(fileToken)
  const rank = Number(rankToken)
  if (file < 1 || file > 9 || rank < 1 || rank > 9) {
    throw new DefinitionSyntaxError(`invalid coordinates in "${key}: ${value}"`, lineNo)
  }
  return { piece, file, rank }
}

function parseBoolHeader(value: string, lineNo: number, key: string): boolean {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  throw new DefinitionSyntaxError(`${key} must be "true" or "false", got "${value}"`, lineNo)
}

/**
 * `bishop_exchange: self|opponent|any`。仕掛けた側は**判定する陣営から見て**言う。
 *
 * `true` も `any` として通す — 「角交換したか」だけを言いたい書き手が真っ先に書く形で、
 * 他の真偽ヘッダと綴りが揃うので、弾く理由が無い。
 */
function parseBishopExchangeHeader(value: string, lineNo: number): BishopExchange {
  const trimmed = value.trim()
  if (trimmed === 'self' || trimmed === 'opponent' || trimmed === 'any') return trimmed
  if (trimmed === 'true') return 'any'
  throw new DefinitionSyntaxError(
    `bishop_exchange must be "self", "opponent" or "any", got "${value}"`,
    lineNo,
  )
}

/** パース中のセクション状態。 */
export type Section = {
  startLine: number
  name: string | null
  parent: string | null
  aliases: string[]
  side: FormationSide | null
  category: boolean
  /** カテゴリと両立しないヘッダの出現。カテゴリのときだけ finalizeSection が咎める。 */
  conditionHeaders: { key: string; line: number }[]
  plyEq: number | null
  plyMin: number | null
  plyMax: number | null
  evaluateAtGameEnd: boolean
  priority: number | null
  noDrop: boolean
  bishopExchange: BishopExchange | null
  finishMoves: ParsedFinishMove[]
  extras: PlacementCell[]
  gridRows: { cells: string[]; line: number }[]
}

export function newSection(): Section {
  return {
    startLine: 0,
    name: null,
    parent: null,
    aliases: [],
    side: null,
    category: false,
    conditionHeaders: [],
    plyEq: null,
    plyMin: null,
    plyMax: null,
    evaluateAtGameEnd: false,
    priority: null,
    noDrop: false,
    bishopExchange: null,
    finishMoves: [],
    extras: [],
    gridRows: [],
  }
}

/**
 * `category: true` と両立しないヘッダ。カテゴリは盤の形も成立条件も持たないので、
 * 書かれていたら**黙って無視せず構文エラーにする** (書いたのに効かない定義を作らせない)。
 */
export const CATEGORY_FORBIDDEN: ReadonlySet<string> = new Set([
  'board',
  'hand',
  'ply',
  'unmoved',
  'visited',
  'igyoku',
  'evaluate_at_game_end',
  'finish',
  'no_drop',
  'bishop_exchange',
])

/**
 * カテゴリの締め。ヘッダの順序に依らず言いたいので (`category:` は `ply:` の後にも
 * 書ける)、セクションを読み切ってからまとめて咎める。
 */
export function checkCategorySection(section: Section): void {
  const offending = section.conditionHeaders[0]
  if (offending !== undefined) {
    throw new DefinitionSyntaxError(
      `section "${section.name}": "${offending.key}" cannot be used with "category: true"`,
      offending.line,
    )
  }
  const firstRow = section.gridRows[0]
  if (firstRow !== undefined) {
    throw new DefinitionSyntaxError(
      `section "${section.name}": "category: true" takes no grid rows, got ${section.gridRows.length}`,
      firstRow.line,
    )
  }
}

export function applyHeader(section: Section, key: string, value: string, lineNo: number): void {
  if (CATEGORY_FORBIDDEN.has(key)) section.conditionHeaders.push({ key, line: lineNo })
  if (key === 'parent') {
    section.parent = value
  } else if (key === 'aliases') {
    section.aliases = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
  } else if (key === 'side') {
    if (value !== 'ibisha' && value !== 'furibisha' && value !== 'either') {
      throw new DefinitionSyntaxError(`side must be ibisha|furibisha|either, got "${value}"`, lineNo)
    }
    section.side = value
  } else if (key === 'board') {
    for (const token of value.split(/\s+/).filter((t) => t !== '')) {
      section.extras.push(cell('pieceAnywhere', { pieceTypes: [pieceTypeOf(token, lineNo)] }))
    }
  } else if (key === 'hand') {
    // `hand: B*2 R` → `X*N` で N 枚指定。省略時は 1 枚。
    for (const token of value.split(/\s+/).filter((t) => t !== '')) {
      const starIdx = token.indexOf('*')
      const pieceToken = starIdx < 0 ? token : token.slice(0, starIdx)
      const num = starIdx < 0 ? '1' : token.slice(starIdx + 1)
      if (!isDigits(num) || Number(num) < 1) {
        throw new DefinitionSyntaxError(`invalid hand count in "${token}"`, lineNo)
      }
      section.extras.push(
        cell('handPiece', { pieceTypes: [pieceTypeOf(pieceToken, lineNo)], minCount: Number(num) }),
      )
    }
  } else if (key === 'category') {
    // 盤の形を持たない分類の節。系統を繋ぐだけで、検出としては出てこない。
    section.category = parseBoolHeader(value, lineNo, 'category')
  } else if (key === 'description') {
    // 人間向けコメント。意図的に無視する。
  } else if (key === 'ply') {
    const { eq, min, max } = parsePlyHeader(value, lineNo)
    if (eq !== null) section.plyEq = eq
    if (min !== null) section.plyMin = min
    if (max !== null) section.plyMax = max
  } else if (key === 'unmoved') {
    // 駒種トークンは可読性のため必須だが PieceUnmoved は駒種を持たないので捨てる。
    const { file, rank } = parseCoordHeader(value, lineNo, 'unmoved')
    section.extras.push(cell('pieceUnmoved', { file, rank }))
  } else if (key === 'visited') {
    const { piece, file, rank } = parseCoordHeader(value, lineNo, 'visited')
    section.extras.push(cell('pieceVisited', { file, rank, pieceTypes: [piece] }))
  } else if (key === 'igyoku') {
    // igyoku: true は KingIgyoku を足しつつ evaluateAtGameEnd も立てる。
    if (parseBoolHeader(value, lineNo, 'igyoku')) {
      section.extras.push(cell('kingIgyoku', {}))
      section.evaluateAtGameEnd = true
    }
  } else if (key === 'evaluate_at_game_end') {
    section.evaluateAtGameEnd = parseBoolHeader(value, lineNo, 'evaluate_at_game_end')
  } else if (key === 'finish') {
    // 成立させた手。行を複数書いてもよい (そのどれかの手なら成立)。
    section.finishMoves.push(...parseFinishHeader(value, lineNo))
  } else if (key === 'priority') {
    // 同時に成立したときの並び順。成立の可否には関わらないので、カテゴリにも書ける。
    section.priority = parsePriorityHeader(value, lineNo)
  } else if (key === 'no_drop') {
    // 打って形を揃えた成立を認めない。判定に履歴が要るので走査でしか効かない。
    section.noDrop = parseBoolHeader(value, lineNo, 'no_drop')
  } else if (key === 'bishop_exchange') {
    // 角交換の有無。仕掛けた側まで縛れる。no_drop と同じく履歴が要る。
    section.bishopExchange = parseBishopExchangeHeader(value, lineNo)
  } else {
    throw new DefinitionSyntaxError(`unknown header "${key}"`, lineNo)
  }
}

export { parseHeaderLine }
