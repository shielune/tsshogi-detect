// WASM の走査器と TS 版の突き合わせに使う作り物の定義。囲い・戦法の定義集には
// 出てこない書き方 (最終手・打たず・角交換・持駒・通過・居玉・分類・手数・優先度・
// 同じ名前・別名の親・親の循環) を一通り並べる。
//
// DSL で書けるものは parseDefinitionFile を通し (scripts/generate-definitions.ts と
// 同じ対応で要件のオブジェクトにする)、DSL では書けない端の形だけ直に組む。

import { Color, PieceType } from 'tsshogi'
import type { DefinitionFinishMove, FormationDefinition } from '../src/definition.ts'
import { type ParsedDefinition, type PlacementCell, parseDefinitionFile } from '../src/parser.ts'
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

/** 升の中身を `'58': 'K'` のように書いて 9 行の盤にする (筋 9 が左、段 1 が上) */
function grid(cells: Readonly<Record<string, string>>): string {
  const rows: string[] = []
  for (let rank = 1; rank <= 9; rank += 1) {
    const row: string[] = []
    for (let file = 9; file >= 1; file -= 1) row.push(cells[`${file}${rank}`] ?? '.')
    rows.push(row.join(' '))
  }
  return rows.join('\n')
}

/** 節 1 つ。cells を省くと分類の節 (盤を書かない) */
function section(name: string, headers: readonly string[], cells?: Record<string, string>): string {
  return [`=== name: ${name}`, ...headers, '', ...(cells === undefined ? [] : [grid(cells)]), ''].join(
    '\n',
  )
}

const SOURCE = [
  // 系統: 別名で書いた親・分類を挟んだ親・宙に浮いた分類・循環・同じ名前・自分が親
  section('上がり玉', ['side: ibisha', 'description: 玉が一つ上がった'], { 58: 'K', 59: '_', 57: '*' }),
  section('上がり玉の子', ['parent: 上がり玉', 'aliases: 旧上がり子, 被り'], {
    48: '[GS]',
    28: '[!R]',
  }),
  section('孫', ['parent: 旧上がり子'], { 51: 'k', 82: '?r', 72: '?r', 22: '[!r]' }),
  section('分類', ['category: true', 'parent: 上がり玉']),
  section('小分類', ['category: true', 'parent: 分類', 'priority: 2']),
  section('分類の子', ['parent: 小分類'], { 28: '?[RB]', 88: '?[RB]', 77: '_' }),
  section('宙の分類', ['category: true']),
  section('宙の子', ['parent: 宙の分類'], { 58: 'G' }),
  section('甲', ['parent: 乙'], { 68: 'S' }),
  section('乙', ['parent: 甲'], { 48: 'S' }),
  section('環', ['category: true', 'parent: 輪']),
  section('輪', ['category: true', 'parent: 環']),
  section('環の子', ['parent: 環'], { 98: 'L' }),
  section('被り', [], { 77: 'B' }),
  section('被り', ['priority: 1'], { 66: 'B' }),
  section('被りの子', ['parent: 被り', 'hand: P'], {}),
  section('自分が親', ['parent: 自分が親'], { 56: 'P' }),

  // 最終手
  section('歩突き', ['finish: 7 6'], { 76: 'P' }),
  section('歩突き元', ['finish: 7 7 > 7 6, 3 7 > 3 6'], {}),
  section('角成り', ['finish: 8 8 > 2 2 +, 3 3 +', 'finish: 2 3 +'], {}),
  section('打ち', ['finish: 5 5 打, 5 6 打, 4 5 打'], {}),
  section('取り', ['finish: 7 6 x *, 6 5 x *, 5 5 x *, 4 5 x *, 3 6 x *, 2 4 x *'], {}),
  section('取らず', ['finish: 2 6 x _, 5 8 x _, 6 8 > 5 8 x _'], {}),
  section('大駒取り', ['finish: 8 8 x [BR], 2 2 x B, 5 5 x +B, 2 8 x R, 7 7 x [BR]'], {}),
  section('小駒取り', ['finish: 5 5 x [!BR], 7 6 x P, 3 3 x [!P], 2 4 x [!BR]'], {}),
  section('初手歩突き', ['finish: 7 6', 'ply: 1'], { 76: 'P' }),
  section('打たず取り', ['finish: 5 5 x *, 4 5 x *, 6 5 x *', 'no_drop: true'], { 55: '*' }),
  section('交換後の取り', ['finish: 2 4 x *, 7 6 x *, 5 5 x *', 'bishop_exchange: any'], {}),

  // 打たず。升の要件の種類ごとに (駒・候補の駒・何か・? の組・相手の駒・否定)
  section('打たずの金銀', ['no_drop: true'], { 56: '?[GS]', 46: '?[GS]', 66: '?[GS]' }),
  section('金銀', [], { 56: '?[GS]', 46: '?[GS]', 66: '?[GS]' }),
  section('打たずの歩', ['no_drop: true'], { 55: 'P' }),
  section('打たずの何か', ['no_drop: true'], { 45: '*' }),
  section('打たずの金', ['no_drop: true'], { 65: '[GS]' }),
  section('打たずの相手', ['no_drop: true'], { 54: 'p', 44: '[!P]' }),

  // 角交換
  section('角交換自分', ['bishop_exchange: self'], { 88: '_' }),
  section('角交換相手', ['bishop_exchange: opponent'], { 88: '_' }),
  section('角交換', ['bishop_exchange: true'], {}),
  section('角交換せず', ['bishop_exchange: never', 'ply: min 30'], {}),

  // 持駒と盤のどこか
  section('歩三枚', ['hand: P*3 S'], {}),
  section('大駒持ち', ['hand: B R'], {}),
  section('龍', ['board: +R'], {}),
  section('馬桂', ['board: +B N'], { 55: '_' }),

  // 動かない駒と通った升
  section('動かない玉', ['unmoved: K 5 9', 'visited: S 5 8'], { 59: 'K' }),
  section('動かない銀', ['unmoved: S 3 9'], {}),
  section('通った玉', ['visited: K 6 8'], {}),
  section('通った龍', ['visited: +R 2 3'], {}),
  section('通った玉の手数', ['visited: K 4 8', 'ply: min 20'], {}),

  // 終局で見る
  section('居玉', ['igyoku: true'], {}),
  section('終局飛車', ['evaluate_at_game_end: true'], { 28: 'R' }),
  section('上がり玉の終局', ['parent: 上がり玉', 'evaluate_at_game_end: true'], { 58: 'K' }),
  section(
    '終局の制約',
    ['evaluate_at_game_end: true', 'ply: max 5', 'finish: 7 6', 'no_drop: true'],
    { 77: 'P' },
  ),
  section('終局の角交換', ['evaluate_at_game_end: true', 'bishop_exchange: self'], {}),
  section('龍', ['evaluate_at_game_end: true', 'board: +R'], {}),

  // 手数と優先度
  section('初手', ['ply: 1'], { 76: 'P' }),
  section('中盤', ['ply: min 10, max 30'], { 57: '_' }),
  section('序盤優先', ['ply: max 5', 'priority: 5'], { 27: '_' }),
  section('終盤', ['ply: min 60'], { 55: '*' }),
  section('低優先', ['priority: -3'], { 97: '_' }),
  section('二手目', ['ply: 2'], { 34: 'p' }),
  section('同順位の甲', [], { 26: '_' }),
  section('同順位の乙', [], { 76: '_' }),

  // 相手の駒の否定
  section('相手の否定', [], { 82: '[!r]', 22: '[!b]' }),
].join('\n')

const one = (cell: PlacementCell): PieceType => {
  const type = cell.pieceTypes[0]
  if (type === undefined) throw new Error(`${cell.kind} has no piece type`)
  return type
}

/** 中間表現 1 件を要件にする (scripts/generate-definitions.ts の requirement と同じ対応) */
function requirement(cell: PlacementCell): DefinitionRequirement {
  switch (cell.kind) {
    case 'exact':
      return new PiecePlacement(cell.file, cell.rank, one(cell))
    case 'opponent':
      return new PiecePlacement(cell.file, cell.rank, one(cell), Color.WHITE)
    case 'anyOf':
      return new AnyOfPieces(cell.file, cell.rank, cell.pieceTypes)
    case 'notOf':
      return new NotOfPieces(cell.file, cell.rank, cell.pieceTypes)
    case 'opponentNotOf':
      return new NotOfPieces(cell.file, cell.rank, cell.pieceTypes, Color.WHITE)
    case 'empty':
      return new EmptySquare(cell.file, cell.rank)
    case 'anyPiece':
      return new AnyPiece(cell.file, cell.rank)
    case 'pieceAnywhere':
      return new PieceAnywhere(one(cell))
    case 'handPiece':
      return new HandPiece(one(cell), cell.minCount)
    case 'pieceUnmoved':
      return new PieceUnmoved(cell.file, cell.rank)
    case 'pieceVisited':
      return new PieceVisited(cell.file, cell.rank, one(cell))
    case 'kingIgyoku':
      return new KingIgyoku()
    case 'pieceInSquares':
      return new PieceInSquares(cell.squares, cell.pieceTypes)
    case 'opponentInSquares':
      return new PieceInSquares(cell.squares, cell.pieceTypes, Color.WHITE)
  }
}

/** 解析結果を定義にする。無い項目はキーごと落とす (生成物と同じ形) */
export function toFormationDefinition(parsed: ParsedDefinition): FormationDefinition {
  const finishMoves = parsed.finishMoves.map(
    (move): DefinitionFinishMove => ({
      ...(move.from === null ? {} : { from: move.from }),
      to: move.to,
      ...(move.capture === null ? {} : { capture: move.capture }),
      ...(move.promote ? { promote: true } : {}),
      ...(move.drop ? { drop: true } : {}),
    }),
  )
  return {
    name: parsed.name,
    ...(parsed.aliases.length > 0 ? { aliases: parsed.aliases } : {}),
    ...(parsed.parent === null ? {} : { parent: parsed.parent }),
    ...(parsed.side === null ? {} : { side: parsed.side }),
    ...(parsed.category ? { category: true } : {}),
    ...(parsed.plyEq === null ? {} : { plyEq: parsed.plyEq }),
    ...(parsed.plyMin === null ? {} : { plyMin: parsed.plyMin }),
    ...(parsed.plyMax === null ? {} : { plyMax: parsed.plyMax }),
    ...(parsed.evaluateAtGameEnd ? { evaluateAtGameEnd: true } : {}),
    ...(parsed.priority === null ? {} : { priority: parsed.priority }),
    ...(parsed.noDrop ? { noDrop: true } : {}),
    ...(parsed.bishopExchange === null ? {} : { bishopExchange: parsed.bishopExchange }),
    ...(finishMoves.length > 0 ? { finishMoves } : {}),
    placements: parsed.placements.map(requirement),
  }
}

/** DSL で書いた作り物の定義 */
export const SYNTHETIC_DEFINITIONS: readonly FormationDefinition[] =
  parseDefinitionFile(SOURCE).map(toFormationDefinition)

/**
 * DSL では書けない端の形。どれも TS 版の走査が受け付けるので、走査器も同じに振る舞う必要がある
 */
export const EDGE_DEFINITIONS: readonly FormationDefinition[] = [
  // 居玉を毎手の判定に回す。局面だけの判定 (detectDefinitions) では履歴が近似になる
  { name: '毎手の居玉', placements: [new KingIgyoku()] },
  { name: '毎手の居玉と手数', plyMin: 3, placements: [new KingIgyoku()] },
  // 終局で見る分類。分類でも終局の判定には回る
  { name: '終局の分類', category: true, evaluateAtGameEnd: true, placements: [] },
  { name: '分類の子の終局', parent: '終局の分類', placements: [new PiecePlacement(7, 6, PieceType.PAWN)] },
  // 常に真・常に偽になる要件
  { name: '持駒ゼロ枚', placements: [new HandPiece(PieceType.ROOK, 0)] },
  { name: '持駒負の枚数', placements: [new HandPiece(PieceType.GOLD, -2)] },
  { name: '升の無い組', placements: [new PieceInSquares([], [PieceType.GOLD])] },
  { name: '候補の無い升', placements: [new AnyOfPieces(5, 5, [])] },
  { name: '除外の無い升', placements: [new NotOfPieces(5, 5, [])] },
  { name: '相手の除外の無い升', placements: [new NotOfPieces(5, 3, [], Color.WHITE)] },
  // 同じ升を二度書く・矛盾する要件
  {
    name: '同じ升を二度',
    placements: [new PiecePlacement(7, 6, PieceType.PAWN), new AnyOfPieces(7, 6, [PieceType.PAWN])],
  },
  {
    name: '矛盾',
    placements: [new EmptySquare(7, 7), new AnyPiece(7, 7)],
  },
  // 相手の組の打たず (相手の駒は打ちを問わない)
  {
    name: '打たずの相手の組',
    noDrop: true,
    placements: [new PieceInSquares([{ file: 5, rank: 5 }, { file: 5, rank: 4 }], [PieceType.PAWN], Color.WHITE)],
  },
  // 打ちの手で盤上の升と取った駒を同時に書く (DSL は断るが、形としては通る)
  {
    name: '打ちと取り',
    finishMoves: [
      { to: { file: 5, rank: 5 }, drop: true, capture: { kind: 'any' } },
      { from: { file: 7, rank: 7 }, to: { file: 7, rank: 6 }, drop: true },
      { to: { file: 5, rank: 6 }, drop: true, promote: true },
    ],
    placements: [],
  },
  // 手数の下限が上限を越える (成立しない)
  { name: '手数の逆転', plyMin: 10, plyMax: 5, placements: [] },
  { name: '手数ゼロ', plyEq: 0, placements: [] },
  // 名前が空・親が空
  { name: '', placements: [new PiecePlacement(7, 6, PieceType.PAWN)] },
  { name: '空の子', parent: '', placements: [new EmptySquare(7, 7)] },
]
