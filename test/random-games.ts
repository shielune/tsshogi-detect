// 乱数で指し進めた棋譜 (USI 文字列の列)。WASM の走査器と TS 版の突き合わせ試験と、
// scripts/bench-wasm.ts が使う。種を決めれば同じ棋譜が出る。
//
// 合法手は tsshogi の isValidMove で選ぶので、玉を打つ `K*` (tsshogi が通す手) も
// ときどき混ぜる。途中に読めない手や不正な手を差し込むこともあり、buildMoves は
// そこで止まる。止まった後ろも指し続けて残す (走査器が同じ所で止まるかを見るため)。

import {
  handPieceTypes,
  type Move,
  movableDirections,
  MoveType,
  Position,
  resolveMoveType,
  Square,
} from 'tsshogi'

/** 線形合同法。0 以上 1 未満を返す */
export function seededRandom(seed: number): () => number {
  let state = seed & 0x7fffffff
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    return state / 0x80000000
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)]
  if (item === undefined) throw new Error('pick from an empty list')
  return item
}

/** 盤上の駒を動かす手と打つ手のうち、isValidMove が通すもの (成・不成は別の手) */
export function legalMoves(position: Position): Move[] {
  const moves: Move[] = []
  for (const from of Square.all) {
    const piece = position.board.at(from)
    if (piece === null || piece.color !== position.color) continue
    for (const direction of movableDirections(piece)) {
      const long = resolveMoveType(piece, direction) === MoveType.LONG
      for (let to = from.neighbor(direction); to.valid; to = to.neighbor(direction)) {
        const target = position.board.at(to)
        if (target !== null && target.color === piece.color) break
        const move = position.createMove(from, to)
        if (move !== null) {
          if (position.isValidMove(move)) moves.push(move)
          const promoted = move.withPromote()
          if (position.isValidMove(promoted)) moves.push(promoted)
        }
        if (target !== null || !long) break
      }
    }
  }
  const hand = position.hand(position.color)
  for (const type of handPieceTypes) {
    if (hand.count(type) === 0) continue
    for (const to of Square.all) {
      if (position.board.at(to) !== null) continue
      const move = position.createMove(type, to)
      if (move !== null && position.isValidMove(move)) moves.push(move)
    }
  }
  return moves
}

/** 読めない・通らない手。buildMoves はここで止まる */
const BROKEN = ['', '7g', '5e5e', 'resign', '７ｇ７ｆ', 'P*5e+', 'K*', '0a1b', '1j1i', '5i5a']

/**
 * 指した手の文字列を崩す。5 文字目より後ろは tsshogi が読まないので、手の意味は
 * 変わらないものが多い (`7g7fX`) が、`+` を足すと成る手に変わり、通らなくなることもある
 */
function garble(random: () => number, usi: string): string {
  const drop = usi[1] === '*'
  switch (Math.floor(random() * 5)) {
    case 0:
      return `${usi}X`
    case 1:
      return usi.length === 4 ? `${usi}+extra` : `${usi}extra`
    case 2:
      // 5 文字目がサロゲートの片割れになる
      return `${usi}😀`
    case 3:
      // 小文字の打ちも tsshogi は駒種だけ見て通す
      return drop ? `${usi[0]?.toLowerCase()}${usi.slice(1)}` : `${usi}＋`
    default:
      return drop ? `${usi}+` : usi.toUpperCase()
  }
}

export type RandomGameOptions = {
  /** 指す手数の上限。詰んだらそこで終わる */
  readonly plies: number
  /** 不正な手を差し込む確率 (1 局あたり) */
  readonly brokenRate?: number
  /** 指した手の文字列を崩す確率 (1 手あたり) */
  readonly garbleRate?: number
  /** 玉を打つ確率 (1 手あたり) */
  readonly kingDropRate?: number
  /** 先に指しておく手 (合法手に限る)。実戦の序盤から枝分かれさせるときに使う */
  readonly prefix?: readonly string[]
}

/**
 * 平手から乱数で指し進める。序盤 40 手は駒を取らない手を好み (盤が早く崩れないように)、
 * 持駒があれば 4 回に 1 回ほどは打つ
 */
export function randomGame(random: () => number, options: RandomGameOptions): string[] {
  const position = new Position()
  const usis: string[] = []
  for (const usi of options.prefix ?? []) {
    const move = position.createMoveByUSI(usi)
    if (move === null || !position.doMove(move)) throw new Error(`prefix has an illegal move ${usi}`)
    usis.push(usi)
  }
  const brokenAt =
    random() < (options.brokenRate ?? 0) ? Math.floor(random() * options.plies) : -1
  for (let ply = usis.length; ply < options.plies; ply += 1) {
    if (ply === brokenAt) usis.push(pick(random, BROKEN))
    if (random() < (options.kingDropRate ?? 0)) {
      const usi = `K*${pick(random, Square.all).usi}`
      const move = position.createMoveByUSI(usi)
      if (move !== null && position.doMove(move)) {
        usis.push(usi)
        continue
      }
    }
    const moves = legalMoves(position)
    if (moves.length === 0) break
    const drops = moves.filter((move) => !(move.from instanceof Square))
    const quiet = moves.filter((move) => move.capturedPieceType === null)
    const pool =
      drops.length > 0 && random() < 0.25 ? drops : ply < 40 && quiet.length > 0 ? quiet : moves
    const move = pick(random, pool)
    position.doMove(move, { ignoreValidation: true })
    usis.push(random() < (options.garbleRate ?? 0) ? garble(random, move.usi) : move.usi)
  }
  return usis
}

/** 種から n 局まとめて作る */
export function randomGames(seed: number, count: number, options: RandomGameOptions): string[][] {
  const random = seededRandom(seed)
  return Array.from({ length: count }, () => randomGame(random, options))
}
