import { describe, expect, test } from 'bun:test'
import {
  Color,
  InitialPositionType,
  Move,
  Piece,
  PieceType,
  Position,
  Square,
} from 'tsshogi'
import { KNOWN_PROVERBS, detectProverbsAtMove, recordProverbs } from '../src/proverb.ts'

function emptyPosition(turn = Color.BLACK): Position {
  const position = new Position()
  position.reset(InitialPositionType.EMPTY)
  position.board.set(new Square(9, 9), new Piece(Color.BLACK, PieceType.KING))
  position.board.set(new Square(9, 1), new Piece(Color.WHITE, PieceType.KING))
  position.setColor(turn)
  return position
}

function apply(position: Position, move: Move) {
  const before = position.clone()
  expect(position.doMove(move, { ignoreValidation: true })).toBe(true)
  return { before, after: position.clone() }
}

function relations(position: Position, move: Move): Map<string, string> {
  const { before, after } = apply(position, move)
  return new Map(detectProverbsAtMove(move, before, after).map((p) => [p.name, p.relation]))
}

describe('proverb registry', () => {
  test('機械的に判定できる13格言とrelationを公開する', () => {
    expect(KNOWN_PROVERBS.map((p) => [p.name, p.relation])).toEqual([
      ['居玉は避けよ', 'follows'],
      ['金は引く手に好手あり', 'pattern'],
      ['桂の王手は合駒きかず', 'state'],
      ['端玉には端歩', 'follows'],
      ['桂は控えて打て', 'follows'],
      ['下段の香に力あり', 'follows'],
      ['金底の歩、岩よりも堅し', 'follows'],
      ['焦点の歩に好手あり', 'pattern'],
      ['飛車は十字に使え', 'follows'],
      ['銀は成らずに好手あり', 'pattern'],
      ['角には角', 'follows'],
      ['中段玉は寄せにくし', 'state'],
      ['玉飛接近すべからず', 'violates'],
    ])
  })
})

describe('detectProverbsAtMove', () => {
  test('居玉を離れる手は follows', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 9))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    const move = new Move(
      new Square(5, 9),
      new Square(4, 9),
      false,
      Color.BLACK,
      PieceType.KING,
      null,
    )
    expect(relations(position, move).get('居玉は避けよ')).toBe('follows')
  })

  test('金を引く形は pattern であって好手認定しない', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.GOLD))
    const move = new Move(
      new Square(5, 5),
      new Square(5, 6),
      false,
      Color.BLACK,
      PieceType.GOLD,
      null,
    )
    expect(relations(position, move).get('金は引く手に好手あり')).toBe('pattern')
  })

  test('桂の王手は state', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 1))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.KING))
    position.blackHand.add(PieceType.KNIGHT, 1)
    const move = new Move(
      PieceType.KNIGHT,
      new Square(4, 3),
      false,
      Color.BLACK,
      PieceType.KNIGHT,
      null,
    )
    expect(relations(position, move).get('桂の王手は合駒きかず')).toBe('state')
  })

  test('焦点の歩は pattern', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.ROOK))
    position.board.set(new Square(1, 1), new Piece(Color.WHITE, PieceType.BISHOP))
    position.blackHand.add(PieceType.PAWN, 1)
    const move = new Move(
      PieceType.PAWN,
      new Square(5, 5),
      false,
      Color.BLACK,
      PieceType.PAWN,
      null,
    )
    expect(relations(position, move).get('焦点の歩に好手あり')).toBe('pattern')
  })
})

describe('recordProverbs', () => {
  test('棋譜走査でplyと手番を付ける', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 9))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    const move = new Move(
      new Square(5, 9),
      new Square(4, 9),
      false,
      Color.BLACK,
      PieceType.KING,
      null,
    )
    const hit = recordProverbs([move], position).find((p) => p.pattern.name === '居玉は避けよ')
    expect(hit?.ply).toBe(1)
    expect(hit?.color).toBe(Color.BLACK)
  })
})
