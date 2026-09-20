// 盤外の要件 (`visited:` `unmoved:` `board:` `hand:` `igyoku:`) の付け外しと書き換え。
//
// 盤の升の要求はグリッドを塗れば変えられるが、ヘッダに書く要件だけは生 DSL を直に
// 書く以外に触る道が無かった。おかげで移植元の定義集から入ってきたまま**誰も外せない
// 指定**が残る (角換わりの `visited: +B 8 8` がまさにそれで、これが 1 行あるだけで
// その定義は永久に成立しない)。パースした要件 1 件から**それを書いている行**を
// 引き当てて、外す・書き換える・足すをここで賄う。
//
// 書き換えは header-text.ts の作法に合わせて**その行だけ**を触る (行末コメントも
// 他のヘッダも動かない)。`board:` と `hand:` は 1 行に駒を並べられるので、触るのは
// トークン 1 つだけで、行が空になったときだけ行ごと消す。
//
// 引き当ては**内容の一致**で行う (要件 1 件から行番号を持ち回らない)。同じ要件が
// 2 つ書いてあれば先に見つけた方を触るが、どちらも同じ意味なので結果は変わらない。

import type { PieceType } from 'tsshogi'
import { headerLines, insertHeaderLine, writeHeaderLine } from './header-text.ts'
import { type PlacementCell, type PlacementKind, SFEN_PIECES } from './parser.ts'

/** 駒種 → 大文字 SFEN トークン。パーサの受理するトークンだけを書く。 */
const PIECE_TOKEN: ReadonlyMap<PieceType, string> = new Map(
  SFEN_PIECES.map(([token, piece]) => [piece, token] as const),
)

/** SFEN トークン → 駒種。DSL は大文字小文字どちらでも書ける。 */
const TOKEN_PIECE: ReadonlyMap<string, PieceType> = new Map(
  SFEN_PIECES.flatMap(([token, piece]) => [
    [token, piece] as const,
    [token.toLowerCase(), piece] as const,
  ]),
)

/** 要件の種類 → それを書くヘッダの鍵。ここに無い種類は盤の升なのでグリッドで触る。 */
const REQUIREMENT_KEY: Partial<Record<PlacementKind, string>> = {
  pieceVisited: 'visited',
  pieceUnmoved: 'unmoved',
  pieceAnywhere: 'board',
  handPiece: 'hand',
  kingIgyoku: 'igyoku',
}

/** その要件はヘッダに書かれているか (= グリッドではなくこの版で触るか)。 */
export function isHeaderRequirement(cell: PlacementCell): boolean {
  return REQUIREMENT_KEY[cell.kind] !== undefined
}

/** 1 行に複数書ける鍵。こちらはトークン 1 つが要件 1 件になる。 */
const MULTI_TOKEN: ReadonlySet<string> = new Set(['board', 'hand'])

const tokensOf = (value: string): string[] => value.split(/\s+/).filter((token) => token !== '')

/** その要件を書いている行と、`board:`/`hand:` ならその中のトークン。 */
type Spot = {
  readonly key: string
  readonly line: number
  /** 行の値をトークンに割ったもの。行ごと消すか組み直すかの判断に使う。 */
  readonly tokens: readonly string[]
  /** 当たったトークンの位置。行 1 本が要件 1 件の鍵 (`visited:` 等) では null。 */
  readonly token: number | null
}

/** 要件 1 件を書いている場所を探す。見つからなければ null。 */
function locate(dsl: string, target: PlacementCell): Spot | null {
  const key = REQUIREMENT_KEY[target.kind]
  if (key === undefined) return null
  for (const header of headerLines(dsl, key)) {
    const tokens = tokensOf(header.value)
    const token = MULTI_TOKEN.has(key)
      ? tokens.findIndex((text) => sameToken(key, text, target))
      : matchesLine(key, tokens, target)
        ? null
        : -1
    if (token === -1) continue
    return { key, line: header.index, tokens, token }
  }
  return null
}

/** 行 1 本が要件 1 件の鍵で、その行が狙いの要件か。 */
function matchesLine(key: string, tokens: readonly string[], target: PlacementCell): boolean {
  if (key === 'igyoku') return tokens[0]?.toLowerCase() === 'true'
  if (tokens.length !== 3) return false
  const square = Number(tokens[1]) === target.file && Number(tokens[2]) === target.rank
  // `unmoved:` の駒種トークンは可読性のためのもので、パーサも捨てている (升だけで引く)
  return key === 'unmoved'
    ? square
    : square && TOKEN_PIECE.get(tokens[0] ?? '') === target.pieceTypes[0]
}

/** `board:`/`hand:` のトークン 1 つが狙いの要件か。持駒は枚数まで見る。 */
function sameToken(key: string, token: string, target: PlacementCell): boolean {
  const star = token.indexOf('*')
  const piece = TOKEN_PIECE.get(star < 0 ? token : token.slice(0, star))
  if (piece !== target.pieceTypes[0]) return false
  return key !== 'hand' || (star < 0 ? 1 : Number(token.slice(star + 1))) === target.minCount
}

/**
 * 要件 1 件の書き方。`unmoved:` だけは駒種トークンを持たない (パーサが捨てるので
 * PlacementCell に残らない) ので、元の行に書いてあったトークンを引き継ぐ。
 */
function requirementText(cell: PlacementCell, key: string, carried?: string): string | null {
  const piece = cell.pieceTypes[0]
  const token = piece === undefined ? undefined : PIECE_TOKEN.get(piece)
  switch (key) {
    case 'igyoku':
      return 'true'
    case 'visited':
      return token === undefined ? null : `${token} ${cell.file} ${cell.rank}`
    case 'unmoved': {
      const written = carried ?? token
      return written === undefined ? null : `${written} ${cell.file} ${cell.rank}`
    }
    case 'board':
      return token ?? null
    case 'hand':
      return token === undefined ? null : `${token}${cell.minCount > 1 ? `*${cell.minCount}` : ''}`
    default:
      return null
  }
}

/** 行の値を組み直す。トークンが 1 つも残らなければ null (= 行ごと消す)。 */
const joinTokens = (tokens: readonly string[]): string | null =>
  tokens.length === 0 ? null : tokens.join(' ')

/** 要件 1 件を外した本文。外せなければ null。 */
export function removeHeaderRequirement(dsl: string, target: PlacementCell): string | null {
  const spot = locate(dsl, target)
  if (spot === null) return null
  const value =
    spot.token === null
      ? null
      : joinTokens(spot.tokens.filter((_token, index) => index !== spot.token))
  return writeHeaderLine(dsl, spot.line, spot.key, value)
}

/**
 * 要件 1 件を書き換えた本文。書き換えられなければ null。
 *
 * 種類は変えられない (`visited:` を `hand:` にはしない) — 別の要件になるので、
 * それは外して足す操作にあたる。
 */
export function updateHeaderRequirement(
  dsl: string,
  target: PlacementCell,
  next: PlacementCell,
): string | null {
  const spot = locate(dsl, target)
  if (spot === null || next.kind !== target.kind) return null
  const text = requirementText(next, spot.key, spot.token === null ? spot.tokens[0] : undefined)
  if (text === null) return null
  return writeHeaderLine(
    dsl,
    spot.line,
    spot.key,
    spot.token === null
      ? text
      : joinTokens(spot.tokens.map((token, index) => (index === spot.token ? text : token))),
  )
}

/**
 * 要件を 1 件足した本文。足せなければ null。
 *
 * `board:`/`hand:` は既にある行へトークンを足す (行を増やさない)。それ以外は
 * 同じ鍵の最後の行の次に 1 行足す。既に同じ要件が書いてあれば本文はそのまま返す。
 */
export function addHeaderRequirement(dsl: string, next: PlacementCell): string | null {
  const key = REQUIREMENT_KEY[next.kind]
  if (key === undefined) return null
  if (locate(dsl, next) !== null) return dsl
  const text = requirementText(next, key)
  if (text === null) return null
  const line = MULTI_TOKEN.has(key) ? headerLines(dsl, key)[0] : undefined
  return line === undefined
    ? insertHeaderLine(dsl, key, text)
    : writeHeaderLine(dsl, line.index, key, `${line.value} ${text}`.trim())
}
