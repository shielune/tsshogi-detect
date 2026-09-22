/**
 * data/*.txt を TypeScript のデータモジュールとして書き出す。
 *
 * 以前は隣の mito-context リポジトリのスクリプトが、自分の src/shogi/definitions/parser.ts
 * を使って data/*.txt を読み、この生成物をこちらへ書き出していた。あちらの txt を
 * 読むパーサがこちらに無く、写しが古くなっても気づけなかったので、パーサ本体
 * (src/parser.ts) をこちらへ移し、自分の data/ から自分の src/ を作れるようにした。
 *
 *   bun run scripts/generate-definitions.ts             # 両方を書き出す
 *   bun run scripts/generate-definitions.ts castles      # 片方だけ
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PieceType } from 'tsshogi'
import type { ParsedFinishMove, ParsedDefinition, PlacementCell } from '../src/parser.ts'
import { parseDefinitionFile } from '../src/parser.ts'
import type { DefinitionFinishCapture, DefinitionSquare } from '../src/definition.ts'

const ROOT = join(import.meta.dir, '..')

/** 要件クラスの名前。出力に現れたものだけを import に載せる (noUnusedLocals 対策)。 */
const CLASS_NAMES = [
  'AnyOfPieces',
  'AnyPiece',
  'EmptySquare',
  'HandPiece',
  'KingIgyoku',
  'NotOfPieces',
  'PieceAnywhere',
  'PieceInSquares',
  'PiecePlacement',
  'PieceUnmoved',
  'PieceVisited',
] as const

type Target = {
  /** 読む txt (data/ からの相対)。 */
  readonly source: string
  /** 書き出し先 (リポジトリルートからの相対)。 */
  readonly out: string
  /** 要件クラスの import 元。 */
  readonly from: string
  /** 定義の型と、その import 行。 */
  readonly type: string
  readonly typeImport: string
  /** export する定数名。 */
  readonly constant: string
}

const TARGETS: Readonly<Record<string, Target>> = {
  castles: {
    source: 'castles.txt',
    out: 'src/castles.gen.ts',
    from: './requirements.ts',
    type: 'FormationDefinition',
    typeImport: "import type { FormationDefinition } from './definition.ts'",
    constant: 'KNOWN_CASTLES',
  },
  strategies: {
    source: 'strategies.txt',
    out: 'src/strategies.gen.ts',
    from: './requirements.ts',
    type: 'FormationDefinition',
    typeImport: "import type { FormationDefinition } from './definition.ts'",
    constant: 'KNOWN_STRATEGIES',
  },
}

/** tsshogi の PieceType 値 → TS の enum メンバ名。 */
const PIECE_NAMES: ReadonlyMap<PieceType, string> = new Map([
  [PieceType.PAWN, 'PAWN'],
  [PieceType.LANCE, 'LANCE'],
  [PieceType.KNIGHT, 'KNIGHT'],
  [PieceType.SILVER, 'SILVER'],
  [PieceType.GOLD, 'GOLD'],
  [PieceType.BISHOP, 'BISHOP'],
  [PieceType.ROOK, 'ROOK'],
  [PieceType.KING, 'KING'],
  [PieceType.PROM_PAWN, 'PROM_PAWN'],
  [PieceType.PROM_LANCE, 'PROM_LANCE'],
  [PieceType.PROM_KNIGHT, 'PROM_KNIGHT'],
  [PieceType.PROM_SILVER, 'PROM_SILVER'],
  [PieceType.HORSE, 'HORSE'],
  [PieceType.DRAGON, 'DRAGON'],
])

function piece(type: PieceType): string {
  const name = PIECE_NAMES.get(type)
  if (name === undefined) throw new Error(`未知の駒種: ${type}`)
  return `PieceType.${name}`
}

const pieces = (types: readonly PieceType[]): string =>
  `[${types.map((type) => piece(type)).join(', ')}]`

const quote = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const square = (value: DefinitionSquare): string => `{ file: ${value.file}, rank: ${value.rank} }`

const squares = (values: readonly DefinitionSquare[]): string =>
  `[${values.map((value) => square(value)).join(', ')}]`

/**
 * 中間表現 1 件を `new ...` の式にする。分岐は build.ts の buildRequirement と同じで、
 * あちらがオブジェクトを作るのに対しこちらはその式の原文を作る。
 */
function requirement(cell: PlacementCell): string {
  const solo = (): string => {
    const type = cell.pieceTypes[0]
    if (type === undefined) throw new Error(`${cell.kind} に駒種が無い`)
    return piece(type)
  }
  switch (cell.kind) {
    case 'exact':
      return `new PiecePlacement(${cell.file}, ${cell.rank}, ${solo()})`
    case 'opponent':
      return `new PiecePlacement(${cell.file}, ${cell.rank}, ${solo()}, Color.WHITE)`
    case 'anyOf':
      return `new AnyOfPieces(${cell.file}, ${cell.rank}, ${pieces(cell.pieceTypes)})`
    case 'notOf':
      return `new NotOfPieces(${cell.file}, ${cell.rank}, ${pieces(cell.pieceTypes)})`
    case 'empty':
      return `new EmptySquare(${cell.file}, ${cell.rank})`
    case 'anyPiece':
      return `new AnyPiece(${cell.file}, ${cell.rank})`
    case 'pieceAnywhere':
      return `new PieceAnywhere(${solo()})`
    case 'handPiece':
      return `new HandPiece(${solo()}, ${cell.minCount})`
    case 'pieceUnmoved':
      return `new PieceUnmoved(${cell.file}, ${cell.rank})`
    case 'pieceVisited':
      return `new PieceVisited(${cell.file}, ${cell.rank}, ${solo()})`
    case 'kingIgyoku':
      return 'new KingIgyoku()'
    case 'pieceInSquares':
      return `new PieceInSquares(${squares(cell.squares)}, ${pieces(cell.pieceTypes)})`
    case 'opponentInSquares':
      return `new PieceInSquares(${squares(cell.squares)}, ${pieces(cell.pieceTypes)}, Color.WHITE)`
  }
}

/** 取った駒の指定。駒を並べる形だけ PieceType を使う。 */
function capture(value: DefinitionFinishCapture): string {
  if (value.kind === 'pieces') {
    return `{ kind: 'pieces', pieces: ${pieces(value.pieces)}, negated: ${value.negated} }`
  }
  return `{ kind: '${value.kind}' }`
}

/** 最終手 1 件。省略できるものは build.ts と同じく、無いときはキーごと落とす。 */
function finishMove(move: ParsedFinishMove): string {
  const parts: string[] = []
  if (move.from !== null) parts.push(`from: ${square(move.from)}`)
  parts.push(`to: ${square(move.to)}`)
  if (move.capture !== null) parts.push(`capture: ${capture(move.capture)}`)
  if (move.promote) parts.push('promote: true')
  if (move.drop) parts.push('drop: true')
  return `{ ${parts.join(', ')} }`
}

/** 定義 1 件のオブジェクトリテラル。キーの並びは FormationDefinition の宣言順。 */
function definition(parsed: ParsedDefinition): string {
  const lines = [`    name: ${quote(parsed.name)},`]
  if (parsed.aliases.length > 0) {
    lines.push(`    aliases: [${parsed.aliases.map((alias) => quote(alias)).join(', ')}],`)
  }
  if (parsed.parent !== null) lines.push(`    parent: ${quote(parsed.parent)},`)
  if (parsed.side !== null) lines.push(`    side: ${quote(parsed.side)},`)
  if (parsed.category) lines.push('    category: true,')
  if (parsed.plyEq !== null) lines.push(`    plyEq: ${parsed.plyEq},`)
  if (parsed.plyMin !== null) lines.push(`    plyMin: ${parsed.plyMin},`)
  if (parsed.plyMax !== null) lines.push(`    plyMax: ${parsed.plyMax},`)
  if (parsed.evaluateAtGameEnd) lines.push('    evaluateAtGameEnd: true,')
  if (parsed.priority !== null) lines.push(`    priority: ${parsed.priority},`)
  if (parsed.noDrop) lines.push('    noDrop: true,')
  if (parsed.bishopExchange !== null) {
    lines.push(`    bishopExchange: ${quote(parsed.bishopExchange)},`)
  }
  if (parsed.finishMoves.length > 0) {
    lines.push('    finishMoves: [')
    for (const move of parsed.finishMoves) lines.push(`      ${finishMove(move)},`)
    lines.push('    ],')
  }
  if (parsed.placements.length === 0) {
    // 盤の形を持たない分類の節 (category: true)
    lines.push('    placements: [],')
  } else {
    lines.push('    placements: [')
    for (const cell of parsed.placements) lines.push(`      ${requirement(cell)},`)
    lines.push('    ],')
  }
  return `  {\n${lines.join('\n')}\n  },`
}

/** 本文に現れた語彙だけを import する。 */
function header(target: Target, body: string): string {
  const tsshogi = ['Color', 'PieceType'].filter((name) => body.includes(`${name}.`))
  const used = CLASS_NAMES.filter((name) => body.includes(`new ${name}(`))
  // クラスをモジュールごとにまとめる。並びは import 元の名前順 (biome の整列に合わせる)。
  const byModule = new Map<string, string[]>()
  for (const name of used) {
    byModule.set(target.from, [...(byModule.get(target.from) ?? []), name])
  }
  const imports = [...byModule.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(
      ([module, names]) =>
        `import {\n${names.map((name) => `  ${name},`).join('\n')}\n} from '${module}'`,
    )
  return [
    '// GENERATED by scripts/generate-definitions.ts. DO NOT EDIT.',
    `// Source: data/${target.source} (bioshogi 由来の構造化データ + 定義エディタの編集)`,
    '',
    `import { ${tsshogi.join(', ')} } from 'tsshogi'`,
    ...imports,
    target.typeImport,
    '',
    `export const ${target.constant}: readonly ${target.type}[] = [`,
    '',
  ].join('\n')
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const names = requested.length > 0 ? requested : Object.keys(TARGETS)

for (const name of names) {
  const target = TARGETS[name]
  if (target === undefined) {
    throw new Error(`知らない対象: ${name} (${Object.keys(TARGETS).join(' / ')})`)
  }
  const source = readFileSync(join(ROOT, 'data', target.source), 'utf8')
  const parsed = parseDefinitionFile(source)
  const body = parsed.map((entry) => definition(entry)).join('\n')
  const out = join(ROOT, target.out)
  const text = `${header(target, body)}${body}\n]\n`
  writeFileSync(out, text)
  console.log(`${out} (${parsed.length} 件)`)
}
