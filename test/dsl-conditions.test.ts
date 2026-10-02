import { describe, expect, test } from 'bun:test'
import { Color, PieceType, Record as ShogiRecord } from 'tsshogi'
import {
  addHeaderRequirement,
  isHeaderRequirement,
  removeHeaderRequirement,
  updateHeaderRequirement,
} from '../src/header-requirement.ts'
import { MoveHistory } from '../src/move-history.ts'
import { parseDefinitionFile } from '../src/parser.ts'
import { cell } from '../src/parser-types.ts'
import { HandPiece, KingIgyoku } from '../src/requirements.ts'
import { recordDefinitions, buildMoves } from '../src/scan.ts'
import type { FormationDefinition } from '../src/definition.ts'
import { loadScanner } from '../src/wasm/index.ts'
import { optionBits, SCAN_BITS } from '../src/wasm/encode.ts'
import { scanRaw } from '../src/wasm/scanner.ts'

const grid = Array.from({ length: 9 }, () => '. . . . . . . . .').join('\n')
const dsl = (...headers: string[]) => `=== name: 条件\n${headers.join('\n')}\n\n${grid}\n`
const parsed = (...headers: string[]) => {
  const result = parseDefinitionFile(dsl(...headers))[0]
  if (result === undefined) throw new Error('条件がない')
  return result
}
const play = (text: string) => {
  const record = new ShogiRecord()
  const history = new MoveHistory()
  history.initFromPosition(record.position)
  for (const [index, usi] of text.split(' ').filter(Boolean).entries()) {
    const move = record.position.createMoveByUSI(usi)
    if (move === null) throw new Error(usi)
    history.recordMove(move, index + 1)
    if (!record.append(move)) throw new Error(usi)
  }
  return { record, history }
}

const definitions: FormationDefinition[] = [
  { name: '居玉ではない', placements: [new KingIgyoku(false)] },
  { name: '相手の角', placements: [new HandPiece(PieceType.BISHOP, 1, Color.WHITE)] },
  { name: '自分の角', placements: [new HandPiece(PieceType.BISHOP)] },
]

describe('居玉の三択', () => {
  test('指定なし・要・不を区別し、要の終局評価は変えない', () => {
    expect(parsed().placements).toEqual([])
    expect(parsed('igyoku: true').placements[0]?.kind).toBe('kingIgyoku')
    expect(parsed('igyoku: true').evaluateAtGameEnd).toBe(true)
    expect(parsed('igyoku: false').placements[0]?.kind).toBe('kingNotIgyoku')
    expect(parsed('igyoku: false').evaluateAtGameEnd).toBe(false)
  })

  test('初期位置の玉は要を満たし、不は満たさない。囲えば反転する', () => {
    const before = play('')
    const after = play('5i5h 5a5b')
    for (const side of [Color.BLACK, Color.WHITE]) {
      expect(new KingIgyoku().isSatisfiedBy(before.record.position, side, before.history)).toBe(
        true,
      )
      expect(
        new KingIgyoku(false).isSatisfiedBy(before.record.position, side, before.history),
      ).toBe(false)
      expect(new KingIgyoku().isSatisfiedBy(after.record.position, side, after.history)).toBe(false)
      expect(new KingIgyoku(false).isSatisfiedBy(after.record.position, side, after.history)).toBe(
        true,
      )
      expect(new KingIgyoku(false).isSatisfiedBy(after.record.position, side)).toBe(false)
    }
  })

  test('不の編集・削除・要との切り替えで他の行に触れない', () => {
    const base = dsl('priority: 4')
    const forbidden = cell('kingNotIgyoku', {})
    const required = cell('kingIgyoku', {})
    const added = addHeaderRequirement(base, forbidden) ?? ''
    expect(added).toContain('igyoku: false')
    expect(isHeaderRequirement(forbidden)).toBe(true)
    expect(removeHeaderRequirement(added, forbidden)).toBe(base)
    const changed = updateHeaderRequirement(added, forbidden, required) ?? ''
    expect(changed).toContain('igyoku: true')
    expect(changed).not.toContain('igyoku: false')
    expect(changed).toContain('priority: 4')
    expect(addHeaderRequirement(changed, forbidden)).toContain('igyoku: false')
    expect(addHeaderRequirement(changed, forbidden)).not.toContain('igyoku: true')
  })
})

describe('相手の持駒', () => {
  test('相手の駒と枚数を読み、既存handは自分のまま', () => {
    const cells = parsed('hand: P', 'opponent_hand: B*2 R').placements
    expect(cells.map((item) => item.kind)).toEqual([
      'handPiece',
      'opponentHandPiece',
      'opponentHandPiece',
    ])
    expect(cells[1]?.pieceTypes).toEqual([PieceType.BISHOP])
    expect(cells[1]?.minCount).toBe(2)
    expect(() => parsed('category: true', 'opponent_hand: B')).toThrow()
    expect(() => parsed('opponent_hand: B*0')).toThrow()
  })

  test('判定する陣営の相手を見て、先後を入れ替えても一致する', () => {
    const { record } = play('7g7f 3c3d 8h2b+')
    const own = new HandPiece(PieceType.BISHOP)
    const opponent = new HandPiece(PieceType.BISHOP, 1, Color.WHITE)
    expect(own.isSatisfiedBy(record.position, Color.BLACK)).toBe(true)
    expect(opponent.isSatisfiedBy(record.position, Color.BLACK)).toBe(false)
    expect(own.isSatisfiedBy(record.position, Color.WHITE)).toBe(false)
    expect(opponent.isSatisfiedBy(record.position, Color.WHITE)).toBe(true)
    expect(
      new HandPiece(PieceType.BISHOP, 2, Color.WHITE).isSatisfiedBy(record.position, Color.WHITE),
    ).toBe(false)
  })

  test('相手のトークンだけを書き換え、自分の持駒を消さない', () => {
    const text = dsl('hand: P', 'opponent_hand: B*2 R')
    const target = parsed('hand: P', 'opponent_hand: B*2 R').placements[1]
    if (target === undefined) throw new Error('相手の持駒がない')
    const changed = updateHeaderRequirement(text, target, { ...target, minCount: 3 }) ?? ''
    expect(changed).toContain('opponent_hand: B*3 R')
    expect(changed).toContain('hand: P')
    expect(removeHeaderRequirement(text, target)).toContain('opponent_hand: R')
  })
})

test('新条件がTSとWASMの差分・全件走査で一致する', async () => {
  const scanner = await loadScanner()
  const compiled = scanner.compile(definitions)
  try {
    for (const usis of [
      ['5i5h', '5a5b'],
      ['K*4e', '5a6b', '4e3e'],
      ['7g7f', '3c3d', '8h2b+', '3a2b', '5i5h', '5a5b'],
      ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e', 'B*6e'],
    ]) {
      for (const moverOnly of [false, true]) {
        const options = { moverOnly }
        const expected = recordDefinitions(definitions, buildMoves(usis), options)
        expect(compiled.record(usis, options)).toEqual(expected)
        expect(
          scanRaw(compiled, [usis], optionBits(options) | SCAN_BITS.naive)[0]?.detections,
        ).toEqual(expected)
      }
    }
  } finally {
    compiled.release()
  }
})
