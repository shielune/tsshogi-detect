/**
 * rust/tests/legality.rs が読む照合用のデータを、tsshogi を動かして作る。
 * Rust の盤 (rust/src/board.rs) が tsshogi と同じ手を合法とするかを確かめるためのもの。
 *
 *   bun run scripts/gen-legality-fixture.ts
 *
 * 種を固定した乱数で数十局を指し進め、各局面で「tsshogi が合法とする手の集合」の
 * 数と FNV-1a ハッシュを残す。候補は盤上の全ての (from, to) の成・不成と、
 * 8 種の打ち (P L N S G B R K)。玉を打つ手 (K*) も tsshogi では通るので、たまに指す。
 * ほかに、壊れた USI を createMoveByUSI に通した結果と、狙った局面 (打ち歩詰め、
 * 二歩、玉 2 枚など) での判定も残す。狙った局面では、こちらの見込みと tsshogi の
 * 答えが食い違えばその場で止める。
 *
 * 書き出す行 (rust/tests/fixtures/legality.txt):
 *
 *   probes <hex> ...                 壊れた USI。lib.rs の棋譜の符号 (5 バイト) を 16 進で
 *   game <n>
 *   moves <usi> ...                  指した手
 *   legal <count>:<hash> ...         各局面 (指す前と最後) の合法手の数とハッシュ
 *   probe <ply> <結果>               その局面で probes を通した結果 (n null, v 合法, i 不正)
 *   final <cells> <hands> <turn>     最後の局面。81 升を 2 桁の 16 進、持駒 14 個、手番
 *   case|<name>|<sfen>|<count>:<hash>|<usi>=<結果> ...|<probes の結果>
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Color,
  type Move,
  type Piece,
  PieceType,
  Position,
  Square,
  handPieceTypes,
  pieceTypes,
} from 'tsshogi'

const OUT = join(import.meta.dir, '..', 'rust', 'tests', 'fixtures', 'legality.txt')
const SEED = 20260928
const GAMES = 36
const MAX_PLIES = 120
/** probes を通す手数 */
const PROBE_PLIES = new Set([0, 30, 60, 90, 120])
/** 玉を打つ手を選ぶ確率と、1 局の上限。3 局に 1 局は打たない */
const KING_DROP_RATE = 0.03
const KING_DROPS_PER_GAME = 2

const PROBES = [
  '',
  '7',
  '7g',
  '7g7',
  '7g7f',
  '7g7f+',
  '7g7f+x',
  '7g7fx',
  '7G7F',
  '7g7F',
  '0g7f',
  '7j7f',
  'P*',
  'P*5',
  'P*5e',
  'p*5e',
  'P*5e+',
  'K*5e',
  'k*5e',
  '+P*5e',
  'X*5e',
  'P*0e',
  'P*5j',
  'P+5e',
  '*P5e',
  ' 7g7f',
  '7g7fé',
  '７ｇ７ｆ',
  '5e5e',
  '2h2b+',
  '8h2b+',
  '2h2b',
  '8h2b',
  '5i5h',
  '5a5b',
  '1a1b',
  '9i9h',
  'B*5e',
  'b*5e',
  'R*5e',
  'G*5e',
  'S*5e',
  'N*5e',
  'L*5e',
  'N*5b',
  'L*5a',
  'P*1a',
  'p*1i',
]

/** 狙った局面。checks は「USI → 見込み」(v 合法, i 不正, n null) */
const CASES: { name: string; sfen: string; checks: Record<string, string> }[] = [
  {
    name: 'pawn-drop-mate',
    sfen: '7nk/9/7G1/9/9/9/9/9/4K4 b P 1',
    checks: { 'P*1b': 'i', 'P*5e': 'v', 'P*2b': 'v' },
  },
  {
    // 玉の升を ignore しないので、玉の陰になる 4b が逃げ道に見え、打ち歩詰めにならない
    name: 'pawn-drop-mate-quirk',
    sfen: '3gsg3/R3k4/9/4G4/9/9/9/9/4K4 b P 1',
    checks: { 'P*5c': 'v' },
  },
  {
    name: 'pawn-drop-mate-white',
    sfen: '4k4/9/9/9/9/9/1g7/9/KN7 w p 1',
    checks: { 'p*9h': 'i', 'p*5e': 'v', 'P*9h': 'i' },
  },
  {
    name: 'double-pawn',
    sfen: 'k8/9/5+Pp2/9/9/9/4P4/9/4K4 b P 1',
    checks: { 'P*5e': 'i', 'P*4e': 'v', 'P*3e': 'v', 'P*6a': 'i' },
  },
  {
    name: 'dead-piece-black',
    sfen: 'k8/9/4S4/2S5N/1G4S2/9/9/9/4K4 b LNP 1',
    checks: {
      'L*5a': 'i',
      'N*5b': 'i',
      'P*1a': 'i',
      'N*6c': 'v',
      'L*5b': 'v',
      '1d2b': 'i',
      '1d2b+': 'v',
      '7d7c+': 'v',
      '7d7c': 'v',
      '5c4d+': 'v',
      '5c4d': 'v',
      '3e3d+': 'i',
      '3e3d': 'v',
      '8e8d+': 'i',
      '8e8d': 'v',
      '5i5h+': 'i',
    },
  },
  {
    name: 'dead-piece-white',
    sfen: '4k4/9/9/9/9/9/9/9/K8 w lnp 1',
    checks: { 'p*5i': 'i', 'n*5h': 'i', 'n*5g': 'v', 'l*5i': 'i', 'l*5h': 'v', 'p*1i': 'i' },
  },
  {
    name: 'two-kings-second-attacked',
    sfen: '8r/9/9/9/9/9/P8/9/4K3K b - 1',
    checks: { '9g9f': 'v', '1i1h': 'i', '1i2h': 'v', 'K*5e': 'v', 'k*5e': 'v' },
  },
  {
    name: 'two-kings-white-to-move',
    sfen: '8r/9/9/9/9/9/P8/9/4K3K w - 1',
    checks: { '1a1i': 'v', '1a1i+': 'v', '1a1h': 'v' },
  },
  {
    // 最初の玉 (9a) に王手が掛かっていても、もう 1 枚の玉は行き先の利きしか見ない
    name: 'two-kings-first-attacked',
    sfen: 'K8/9/9/9/9/9/4P4/9/r3K4 b - 1',
    checks: { '5g5f': 'i', '5i5h': 'v', '9a9b': 'i', '9a8a': 'v' },
  },
  {
    name: 'king-drop-blocks-check',
    sfen: '4r4/9/9/9/9/9/9/9/4K4 b - 1',
    checks: { 'K*5e': 'v', 'K*1e': 'i', 'k*5h': 'v' },
  },
  {
    name: 'check-left',
    sfen: '4r4/9/9/9/9/9/P8/5G3/4K4 b G 1',
    checks: { '9g9f': 'i', '4h5h': 'v', 'G*5e': 'v', 'G*4e': 'i', '5i4i': 'v' },
  },
  {
    name: 'king-into-check',
    sfen: '5r3/9/9/9/9/9/9/9/4K4 b - 1',
    checks: { '5i4h': 'i', '5i4i': 'i', '5i6h': 'v', '5i5h': 'v' },
  },
  {
    name: 'king-along-the-ray',
    sfen: '4r4/9/9/9/9/9/9/4K4/9 b - 1',
    checks: { '5h5i': 'i', '5h5g': 'i', '5h4h': 'v' },
  },
  {
    name: 'pinned-silver',
    sfen: '4r4/9/9/9/9/9/9/4S4/4K4 b - 1',
    checks: { '5h4g': 'i', '5h5g': 'v', '5h6g': 'i' },
  },
  {
    name: 'no-own-king',
    sfen: '4r4/9/9/9/9/9/9/4S4/9 b - 1',
    checks: { '5h4g': 'v', 'K*5i': 'v' },
  },
  {
    name: 'capture-and-promoted',
    sfen: 'lnsgkgsnl/1r5b1/ppppp1ppp/5p3/9/2P1+B4/PP1PPPPPP/7R1/LNSGKGSNL b P 1',
    checks: {
      '5f4g': 'i',
      '5f3d': 'v',
      '5f2c': 'v',
      '5f2c+': 'i',
      '5f7d': 'v',
      '5f9b': 'i',
      '5f5g': 'i',
      '5f5e': 'v',
      '5f4e': 'v',
    },
  },
]

const DROP_TYPES = [...handPieceTypes, PieceType.KING]

function legalMoves(position: Position): Move[] {
  const out: Move[] = []
  for (const from of Square.all) {
    const piece = position.board.at(from)
    if (!piece || piece.color !== position.color) continue
    for (const to of Square.all) {
      const move = position.createMove(from, to)
      if (!move) continue
      if (position.isValidMove(move)) out.push(move)
      const promoted = move.withPromote()
      if (position.isValidMove(promoted)) out.push(promoted)
    }
  }
  for (const type of DROP_TYPES) {
    for (const to of Square.all) {
      const move = position.createMove(type, to)
      if (move && position.isValidMove(move)) out.push(move)
    }
  }
  return out
}

/** FNV-1a 32bit。各 USI の後ろに空白を付けて連ねたものを数える */
function summary(moves: Move[]): string {
  let hash = 0x811c9dc5
  for (const move of moves) {
    for (const c of `${move.usi} `) {
      hash ^= c.charCodeAt(0)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return `${moves.length}:${hash.toString(16).padStart(8, '0')}`
}

/** lib.rs の「棋譜の符号」: 0..5 文字目の文字コード。足りなければ 0、128 以上は 0x7f */
function encode(usi: string): string {
  let out = ''
  for (let i = 0; i < 5; i++) {
    const c = i < usi.length ? usi.charCodeAt(i) : 0
    out += (c >= 128 ? 0x7f : c).toString(16).padStart(2, '0')
  }
  return out
}

function judge(position: Position, usi: string): string {
  const move = position.createMoveByUSI(usi)
  if (!move) return 'n'
  return position.isValidMove(move) ? 'v' : 'i'
}

function probe(position: Position): string {
  return PROBES.map((usi) => judge(position, usi)).join('')
}

const cellOf = (piece: Piece | null): number =>
  piece === null ? 0 : ((piece.color === Color.BLACK ? 0 : 1) << 4) | (pieceTypes.indexOf(piece.type) + 1)

function finalState(position: Position): string {
  const cells = Square.all
    .map((square) => cellOf(position.board.at(square)).toString(16).padStart(2, '0'))
    .join('')
  const hands = [position.blackHand, position.whiteHand]
    .flatMap((hand) => handPieceTypes.map((type) => hand.count(type)))
    .join(',')
  return `${cells} ${hands} ${position.color === Color.BLACK ? 0 : 1}`
}

let seed = SEED
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length) % list.length] as T

const lines: string[] = [
  '# bun run scripts/gen-legality-fixture.ts が書き出す。手で直さない',
  `probes ${PROBES.map(encode).join(' ')}`,
]

let kingDropsTotal = 0
for (let game = 0; game < GAMES; game++) {
  const position = new Position()
  const played: string[] = []
  const legal: string[] = []
  const probes: string[] = []
  let kingDrops = 0
  for (let ply = 0; ; ply++) {
    const moves = legalMoves(position)
    legal.push(summary(moves))
    if (PROBE_PLIES.has(ply)) probes.push(`probe ${ply} ${probe(position)}`)
    if (ply === MAX_PLIES) break
    const kingDropMoves = moves.filter((move) => move.from === PieceType.KING)
    const ordinary = moves.filter((move) => move.from !== PieceType.KING)
    if (ordinary.length === 0) break
    let move: Move
    if (
      game % 3 !== 0 &&
      kingDrops < KING_DROPS_PER_GAME &&
      kingDropMoves.length > 0 &&
      rand() < KING_DROP_RATE
    ) {
      move = pick(kingDropMoves)
      kingDrops++
    } else {
      // 序盤は駒を取らない手を好む (盤が早く崩れすぎないように)
      const quiet = ordinary.filter((m) => !position.board.at(m.to))
      move = pick(ply < 40 && quiet.length > 0 ? quiet : ordinary)
    }
    if (!position.doMove(move)) throw new Error(`doMove failed: game ${game} ply ${ply} ${move.usi}`)
    played.push(move.usi)
  }
  kingDropsTotal += kingDrops
  lines.push(`game ${game}`, `moves ${played.join(' ')}`, `legal ${legal.join(' ')}`, ...probes)
  lines.push(`final ${finalState(position)}`)
}

for (const { name, sfen, checks } of CASES) {
  const position = Position.newBySFEN(sfen)
  if (!position) throw new Error(`bad sfen: ${name}`)
  const results = Object.entries(checks).map(([usi, expected]) => {
    const actual = judge(position, usi)
    if (actual !== expected) throw new Error(`${name}: ${usi} は ${expected} の見込みが ${actual}`)
    return `${usi}=${actual}`
  })
  lines.push(`case|${name}|${sfen}|${summary(legalMoves(position))}|${results.join(' ')}|${probe(position)}`)
}

writeFileSync(OUT, `${lines.join('\n')}\n`)
console.log(`${OUT}: ${GAMES} 局 (玉打ち ${kingDropsTotal} 回), ${CASES.length} 局面`)
