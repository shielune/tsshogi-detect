// CSA の指し手を JSON 配列で 1 行 1 局に並べた棋譜 (`[{"m":"+7776FU",...}, ...]` の .jsonl.gz) を、
// 手を空白で区切った USI の 1 行 1 局 (.usi.gz) に直す。ベンチの材料を作るためのもの。
//
//   bun scripts/convert-csa-kifu.ts --out <出力先> <入力.jsonl.gz>...
//
// 行番号は元と揃える (空の局は空行)。平手から始まる前提。合法かどうかは見ない —
// 走査の側が buildMoves と同じく不正な手の手前で打ち切る。成りは、升ごとに駒名を控えた
// 軽い盤で「動かす前が生駒で、CSA の駒名 (動いた後の姿) が成駒」なら `+` を付ける。
// `%` で始まる特殊な手や形の崩れた手に当たったら、その局はそこで打ち切って数える。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'

const PROMOTED = new Set(['TO', 'NY', 'NK', 'NG', 'UM', 'RY'])
const DROP_LETTER: Readonly<Record<string, string>> = {
  FU: 'P',
  KY: 'L',
  KE: 'N',
  GI: 'S',
  KI: 'G',
  KA: 'B',
  HI: 'R',
  OU: 'K',
}
const PIECE_NAMES = new Set([...Object.keys(DROP_LETTER), ...PROMOTED])
const RANK_LETTER = 'abcdefghi'

/** 升の添字。file, rank は 1..9 */
const at = (file: number, rank: number): number => (rank - 1) * 9 + (file - 1)

function hirate(): (string | null)[] {
  const board: (string | null)[] = Array(81).fill(null)
  const back = ['KY', 'KE', 'GI', 'KI', 'OU', 'KI', 'GI', 'KE', 'KY']
  for (let file = 1; file <= 9; file++) {
    board[at(file, 1)] = back[file - 1] ?? null
    board[at(file, 9)] = back[file - 1] ?? null
    board[at(file, 3)] = 'FU'
    board[at(file, 7)] = 'FU'
  }
  board[at(8, 2)] = 'HI'
  board[at(2, 2)] = 'KA'
  board[at(8, 8)] = 'KA'
  board[at(2, 8)] = 'HI'
  return board
}

const CSA_MOVE = /^[+-]([0-9])([0-9])([1-9])([1-9])([A-Z]{2})$/

type Converted = { readonly usis: string[]; readonly truncated: boolean }

/** 1 局ぶんの CSA の手を USI に直す。崩れた手の手前で止める */
function convertGame(moves: readonly string[]): Converted {
  const board = hirate()
  const usis: string[] = []
  for (const move of moves) {
    const match = CSA_MOVE.exec(move)
    if (match === null) return { usis, truncated: true }
    const [, ff, fr, tf, tr, piece] = match as unknown as [string, string, string, string, string, string]
    if (!PIECE_NAMES.has(piece)) return { usis, truncated: true }
    const toFile = Number(tf)
    const toRank = Number(tr)
    const to = `${tf}${RANK_LETTER[toRank - 1]}`
    if (ff === '0' && fr === '0') {
      const letter = DROP_LETTER[piece]
      if (letter === undefined) return { usis, truncated: true }
      usis.push(`${letter}*${to}`)
    } else {
      if (ff === '0' || fr === '0') return { usis, truncated: true }
      const fromFile = Number(ff)
      const fromRank = Number(fr)
      const before = board[at(fromFile, fromRank)]
      const promote = before !== null && before !== undefined && !PROMOTED.has(before) && PROMOTED.has(piece)
      usis.push(`${ff}${RANK_LETTER[fromRank - 1]}${to}${promote ? '+' : ''}`)
      board[at(fromFile, fromRank)] = null
    }
    board[at(toFile, toRank)] = piece
  }
  return { usis, truncated: false }
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string' } },
  allowPositionals: true,
})
if (values.out === undefined || positionals.length === 0) {
  console.error('usage: bun scripts/convert-csa-kifu.ts --out <dir> <input.jsonl.gz>...')
  process.exit(1)
}
mkdirSync(values.out, { recursive: true })

let games = 0
let empty = 0
let plies = 0
let truncated = 0
const started = performance.now()
for (const input of positionals) {
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(input)))
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const out: string[] = []
  for (const line of lines) {
    const records = JSON.parse(line) as { m: string }[]
    games++
    if (records.length === 0) empty++
    const converted = convertGame(records.map((record) => record.m))
    if (converted.truncated) truncated++
    plies += converted.usis.length
    out.push(converted.usis.join(' '))
  }
  const name = basename(input).replace(/\.jsonl\.gz$/, '.usi.gz')
  writeFileSync(join(values.out, name), Bun.gzipSync(new TextEncoder().encode(`${out.join('\n')}\n`)))
  console.log(`${name}: ${lines.length} 局`)
}
const seconds = ((performance.now() - started) / 1000).toFixed(1)
console.log(`局 ${games} (空 ${empty}), 手 ${plies}, 打ち切り ${truncated}, ${seconds} s`)
