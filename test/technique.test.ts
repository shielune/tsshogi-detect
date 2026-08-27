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
import {
  KNOWN_TECHNIQUES,
  detectTechniquesAtMove,
  recordTechniques,
  recordTechniquesFirstOccurrence,
} from '../src/technique.ts'

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

function names(position: Position, move: Move): Set<string> {
  const { before, after } = apply(position, move)
  return new Set(detectTechniquesAtMove(move, before, after).map((t) => t.name))
}

describe('technique registry', () => {
  test('Dart移植94件と追加9件の103手筋を公開する', () => {
    expect(KNOWN_TECHNIQUES).toHaveLength(103)
    const allNames = KNOWN_TECHNIQUES.map((t) => t.name)
    expect(new Set(allNames).size).toBe(allNames.length)
  })
})

describe('detectTechniquesAtMove', () => {
  test('たたきの歩', () => {
    const position = emptyPosition()
    position.board.set(new Square(7, 5), new Piece(Color.WHITE, PieceType.SILVER))
    position.blackHand.add(PieceType.PAWN, 1)
    const move = new Move(
      PieceType.PAWN,
      new Square(7, 6),
      false,
      Color.BLACK,
      PieceType.PAWN,
      null,
    )
    expect(names(position, move).has('たたきの歩')).toBe(true)
  })

  test('焦点の歩', () => {
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
    expect(names(position, move).has('焦点の歩')).toBe(true)
  })

  test('開き王手と両王手を区別する', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 1))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.KING))
    position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.ROOK))
    position.board.set(new Square(5, 3), new Piece(Color.BLACK, PieceType.GOLD))
    const move = new Move(
      new Square(5, 3),
      new Square(4, 3),
      false,
      Color.BLACK,
      PieceType.GOLD,
      null,
    )
    const hits = names(position, move)
    expect(hits.has('開き王手')).toBe(true)
    expect(hits.has('両王手')).toBe(false)
  })

  test('王手飛車は別方向の飛車まで走査する', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 1))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.KING))
    position.board.set(new Square(1, 5), new Piece(Color.WHITE, PieceType.ROOK))
    position.board.set(new Square(5, 3), new Piece(Color.BLACK, PieceType.BISHOP))
    const move = new Move(
      new Square(5, 3),
      new Square(4, 2),
      false,
      Color.BLACK,
      PieceType.BISHOP,
      null,
    )
    expect(names(position, move).has('王手飛車')).toBe(true)
  })

  test('割り打ちの銀', () => {
    const position = emptyPosition()
    position.board.set(new Square(4, 4), new Piece(Color.WHITE, PieceType.GOLD))
    position.board.set(new Square(6, 4), new Piece(Color.WHITE, PieceType.GOLD))
    position.blackHand.add(PieceType.SILVER, 1)
    const move = new Move(
      PieceType.SILVER,
      new Square(5, 5),
      false,
      Color.BLACK,
      PieceType.SILVER,
      null,
    )
    expect(names(position, move).has('割り打ちの銀')).toBe(true)
  })

  test('角交換と角には角', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.BISHOP))
    position.board.set(new Square(3, 3), new Piece(Color.WHITE, PieceType.BISHOP))
    const move = new Move(
      new Square(5, 5),
      new Square(3, 3),
      false,
      Color.BLACK,
      PieceType.BISHOP,
      PieceType.BISHOP,
    )
    const hits = names(position, move)
    expect(hits.has('角交換')).toBe(true)
    expect(hits.has('角には角')).toBe(true)
  })

  test('銀不成は成った手では発火しない', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 4), new Piece(Color.BLACK, PieceType.SILVER))
    const move = new Move(
      new Square(5, 4),
      new Square(5, 3),
      true,
      Color.BLACK,
      PieceType.SILVER,
      null,
    )
    expect(names(position, move).has('銀不成')).toBe(false)
  })

  test('後手側の頭金も反転して検出する', () => {
    const position = emptyPosition(Color.WHITE)
    position.board.remove(new Square(9, 9))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    position.whiteHand.add(PieceType.GOLD, 1)
    const move = new Move(
      PieceType.GOLD,
      new Square(5, 8),
      false,
      Color.WHITE,
      PieceType.GOLD,
      null,
    )
    expect(names(position, move).has('頭金')).toBe(true)
  })

  test('跳ね違いの桂は先後どちらでも前進時に検出する', () => {
    for (const [usi, color] of [
      ['2i3g', Color.BLACK],
      ['8i7g', Color.BLACK],
      ['2a3c', Color.WHITE],
      ['8a7c', Color.WHITE],
    ] as const) {
      const position = new Position()
      position.setColor(color)
      const move = position.createMoveByUSI(usi)
      expect(move).not.toBeNull()
      if (move === null) throw new Error(`move creation failed: ${usi}`)
      expect(names(position, move).has('跳ね違いの桂')).toBe(true)
    }
  })

  test('馬で角を取っても角には角になる', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.HORSE))
    position.board.set(new Square(3, 3), new Piece(Color.WHITE, PieceType.BISHOP))
    const move = new Move(
      new Square(5, 5),
      new Square(3, 3),
      false,
      Color.BLACK,
      PieceType.HORSE,
      PieceType.BISHOP,
    )
    expect(names(position, move).has('角には角')).toBe(true)
  })

  test('角合いは王手への角打ちとして正しい名前で公開する', () => {
    expect(KNOWN_TECHNIQUES.some((t) => t.name === '角合い')).toBe(true)
    expect(KNOWN_TECHNIQUES.some((t) => t.name === '幽霊角')).toBe(false)
  })

  test('飛車切りは相手の利きへ踏み込む手', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.ROOK))
    position.board.set(new Square(5, 3), new Piece(Color.WHITE, PieceType.PAWN))
    const move = new Move(
      new Square(5, 5),
      new Square(5, 4),
      false,
      Color.BLACK,
      PieceType.ROOK,
      null,
    )
    expect(names(position, move).has('飛車切り')).toBe(true)
  })

  test('両王手', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 1))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.KING))
    position.board.set(new Square(5, 5), new Piece(Color.BLACK, PieceType.ROOK))
    position.board.set(new Square(5, 3), new Piece(Color.BLACK, PieceType.SILVER))
    const move = new Move(
      new Square(5, 3),
      new Square(4, 2),
      false,
      Color.BLACK,
      PieceType.SILVER,
      null,
    )
    const hits = names(position, move)
    expect(hits.has('開き王手')).toBe(true)
    expect(hits.has('両王手')).toBe(true)
  })

  test('逆王手', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 9))
    position.board.remove(new Square(9, 1))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    position.board.set(new Square(1, 1), new Piece(Color.WHITE, PieceType.KING))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.ROOK))
    position.board.set(new Square(4, 6), new Piece(Color.BLACK, PieceType.BISHOP))
    const move = new Move(
      new Square(4, 6),
      new Square(5, 5),
      false,
      Color.BLACK,
      PieceType.BISHOP,
      null,
    )
    expect(names(position, move).has('逆王手')).toBe(true)
  })

  test('成り捨て', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 4), new Piece(Color.BLACK, PieceType.SILVER))
    position.board.set(new Square(5, 2), new Piece(Color.WHITE, PieceType.GOLD))
    const move = new Move(
      new Square(5, 4),
      new Square(5, 3),
      true,
      Color.BLACK,
      PieceType.SILVER,
      null,
    )
    expect(names(position, move).has('成り捨て')).toBe(true)
  })

  test('十字飛車', () => {
    const position = emptyPosition()
    position.board.set(new Square(5, 8), new Piece(Color.BLACK, PieceType.ROOK))
    position.board.set(new Square(5, 2), new Piece(Color.WHITE, PieceType.GOLD))
    position.board.set(new Square(2, 5), new Piece(Color.WHITE, PieceType.SILVER))
    const move = new Move(
      new Square(5, 8),
      new Square(5, 5),
      false,
      Color.BLACK,
      PieceType.ROOK,
      null,
    )
    expect(names(position, move).has('十字飛車')).toBe(true)
  })

  test('合駒請求', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 1))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.KING))
    position.board.set(new Square(5, 8), new Piece(Color.BLACK, PieceType.ROOK))
    const move = new Move(
      new Square(5, 8),
      new Square(5, 5),
      false,
      Color.BLACK,
      PieceType.ROOK,
      null,
    )
    expect(names(position, move).has('合駒請求')).toBe(true)
  })

  test('移動合い', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 9))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.ROOK))
    position.board.set(new Square(4, 8), new Piece(Color.BLACK, PieceType.GOLD))
    const move = new Move(
      new Square(4, 8),
      new Square(5, 8),
      false,
      Color.BLACK,
      PieceType.GOLD,
      null,
    )
    expect(names(position, move).has('移動合い')).toBe(true)
  })

  test('中合い', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 9))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.ROOK))
    position.blackHand.add(PieceType.PAWN, 1)
    const move = new Move(
      PieceType.PAWN,
      new Square(5, 5),
      false,
      Color.BLACK,
      PieceType.PAWN,
      null,
    )
    expect(names(position, move).has('中合い')).toBe(true)
  })

  test('玉に隣接する合駒は中合いではない', () => {
    const position = emptyPosition()
    position.board.remove(new Square(9, 9))
    position.board.set(new Square(5, 9), new Piece(Color.BLACK, PieceType.KING))
    position.board.set(new Square(5, 1), new Piece(Color.WHITE, PieceType.ROOK))
    position.blackHand.add(PieceType.PAWN, 1)
    const move = new Move(
      PieceType.PAWN,
      new Square(5, 8),
      false,
      Color.BLACK,
      PieceType.PAWN,
      null,
    )
    expect(names(position, move).has('中合い')).toBe(false)
  })
})

describe('recordTechniques', () => {
  test('first occurrence は同じ手筋・陣営を最初の1回だけ返す', () => {
    const position = emptyPosition()
    position.board.set(new Square(7, 5), new Piece(Color.WHITE, PieceType.SILVER))
    position.board.set(new Square(3, 5), new Piece(Color.WHITE, PieceType.SILVER))
    position.blackHand.add(PieceType.PAWN, 2)
    const moves = [
      new Move(
        PieceType.PAWN,
        new Square(7, 6),
        false,
        Color.BLACK,
        PieceType.PAWN,
        null,
      ),
      new Move(
        PieceType.PAWN,
        new Square(3, 6),
        false,
        Color.BLACK,
        PieceType.PAWN,
        null,
      ),
    ]
    const all = recordTechniques(moves, position).filter((hit) => hit.template.name === 'たたきの歩')
    const first = recordTechniquesFirstOccurrence(moves, position).filter(
      (hit) => hit.template.name === 'たたきの歩',
    )
    expect(all).toHaveLength(2)
    expect(first).toHaveLength(1)
    expect(first[0]?.ply).toBe(1)
  })

  test('棋譜を走査してplyと手番を付ける', () => {
    const position = emptyPosition()
    position.board.set(new Square(7, 5), new Piece(Color.WHITE, PieceType.SILVER))
    position.blackHand.add(PieceType.PAWN, 1)
    const move = new Move(
      PieceType.PAWN,
      new Square(7, 6),
      false,
      Color.BLACK,
      PieceType.PAWN,
      null,
    )
    const hits = recordTechniques([move], position)
    const tataki = hits.find((hit) => hit.template.name === 'たたきの歩')
    expect(tataki?.ply).toBe(1)
    expect(tataki?.color).toBe(Color.BLACK)
  })
})
