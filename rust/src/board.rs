//! 盤と指し手。tsshogi の Position / Board / Move の挙動を写したもの。
//!
//! 合法手の判定 (isValidMove) は tsshogi と同じ結果を返すことだけを目標にする。
//! 将棋として正しいかどうかではない — `K*` (玉を打つ手) が通るのも、
//! 打ち歩詰めの判定で玉の升を無視しないのも、tsshogi に合わせてある。

pub const BLACK: u8 = 0;
pub const WHITE: u8 = 1;

pub const PAWN: u8 = 0;
pub const LANCE: u8 = 1;
pub const KNIGHT: u8 = 2;
pub const SILVER: u8 = 3;
pub const GOLD: u8 = 4;
pub const BISHOP: u8 = 5;
pub const ROOK: u8 = 6;
pub const KING: u8 = 7;
pub const PROM_PAWN: u8 = 8;
pub const PROM_LANCE: u8 = 9;
pub const PROM_KNIGHT: u8 = 10;
pub const PROM_SILVER: u8 = 11;
pub const HORSE: u8 = 12;
pub const DRAGON: u8 = 13;

/// 持駒になる駒種の数 (歩 香 桂 銀 金 角 飛)
pub const HAND_TYPES: usize = 7;

/// 打つ手の移動元
pub const NO_SQUARE: u8 = 0xff;
/// 取らなかった手の取った駒
pub const NO_PIECE: u8 = 0xff;

/// 升の添字。`file` 1..=9, `rank` 1..=9
pub const fn square(file: u8, rank: u8) -> u8 {
    (rank - 1) * 9 + (9 - file)
}

pub const fn file_of(sq: u8) -> u8 {
    9 - sq % 9
}

pub const fn rank_of(sq: u8) -> u8 {
    sq / 9 + 1
}

/// 升の中身。空は 0
pub const fn cell(color: u8, piece_type: u8) -> u8 {
    (color << 4) | (piece_type + 1)
}

/// 駒の居る升の手番。空の升には使わない
pub const fn cell_color(c: u8) -> u8 {
    c >> 4
}

/// 駒の居る升の駒種。空の升には使わない
pub const fn cell_type(c: u8) -> u8 {
    (c & 0x0f) - 1
}

/// 成った駒種。成れない駒はそのまま
pub const fn promoted(piece_type: u8) -> u8 {
    match piece_type {
        PAWN => PROM_PAWN,
        LANCE => PROM_LANCE,
        KNIGHT => PROM_KNIGHT,
        SILVER => PROM_SILVER,
        BISHOP => HORSE,
        ROOK => DRAGON,
        other => other,
    }
}

/// 成る前の駒種。成駒でなければそのまま
pub const fn unpromoted(piece_type: u8) -> u8 {
    match piece_type {
        PROM_PAWN => PAWN,
        PROM_LANCE => LANCE,
        PROM_KNIGHT => KNIGHT,
        PROM_SILVER => SILVER,
        HORSE => BISHOP,
        DRAGON => ROOK,
        other => other,
    }
}

/// 指し手。tsshogi の Move と同じ中身を持つ
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Move {
    /// 移動元の升。打つ手は NO_SQUARE
    pub from: u8,
    pub to: u8,
    /// 動かした (打った) 駒の種類。成る手でも成る前の種類
    pub piece_type: u8,
    pub color: u8,
    pub promote: bool,
    /// 取った駒の種類。盤の上の姿のまま (馬を取れば HORSE)。取らなければ NO_PIECE
    pub captured: u8,
}

impl Move {
    pub const fn is_drop(&self) -> bool {
        self.from == NO_SQUARE
    }
}

// 方向。tsshogi の Direction と同じ 12 方向で、差分は升の (x, y) に足す
// (x = 9 - file, y = rank - 1。上は先手から見た上で y が減る)
const UP: usize = 0;
const DOWN: usize = 1;
const LEFT: usize = 2;
const RIGHT: usize = 3;
const LEFT_UP: usize = 4;
const RIGHT_UP: usize = 5;
const LEFT_DOWN: usize = 6;
const RIGHT_DOWN: usize = 7;
const LEFT_UP_KNIGHT: usize = 8;
const RIGHT_UP_KNIGHT: usize = 9;
const LEFT_DOWN_KNIGHT: usize = 10;
const RIGHT_DOWN_KNIGHT: usize = 11;
const DIRECTIONS: usize = 12;

const DELTAS: [(i8, i8); DIRECTIONS] = [
    (0, -1),
    (0, 1),
    (-1, 0),
    (1, 0),
    (-1, -1),
    (1, -1),
    (-1, 1),
    (1, 1),
    (-1, -2),
    (1, -2),
    (-1, 2),
    (1, 2),
];

/// 逆向き (reverseDirection)
const REVERSE: [usize; DIRECTIONS] = [1, 0, 3, 2, 7, 6, 5, 4, 11, 10, 9, 8];
/// 上下を入れ替えた向き。後手の動きは先手の動きをこれで写す
const FLIP: [usize; DIRECTIONS] = [1, 0, 2, 3, 6, 7, 4, 5, 10, 11, 8, 9];

// 動きの種類 (MoveType)
const NONE: u8 = 0;
const SHORT: u8 = 1;
const LONG: u8 = 2;

const GOLD_DIRECTIONS: [usize; 6] = [LEFT_UP, UP, RIGHT_UP, LEFT, RIGHT, DOWN];

/// `MOVE_TYPE[手番][駒種][方向]`。tsshogi の movableDirectionMap
const MOVE_TYPE: [[[u8; DIRECTIONS]; 14]; 2] = move_types();

const fn move_types() -> [[[u8; DIRECTIONS]; 14]; 2] {
    let mut black = [[NONE; DIRECTIONS]; 14];
    black[PAWN as usize][UP] = SHORT;
    black[LANCE as usize][UP] = LONG;
    black[KNIGHT as usize][LEFT_UP_KNIGHT] = SHORT;
    black[KNIGHT as usize][RIGHT_UP_KNIGHT] = SHORT;
    let silver = [LEFT_UP, UP, RIGHT_UP, LEFT_DOWN, RIGHT_DOWN];
    let mut i = 0;
    while i < silver.len() {
        black[SILVER as usize][silver[i]] = SHORT;
        i += 1;
    }
    let golds = [GOLD, PROM_PAWN, PROM_LANCE, PROM_KNIGHT, PROM_SILVER];
    let mut g = 0;
    while g < golds.len() {
        let mut i = 0;
        while i < GOLD_DIRECTIONS.len() {
            black[golds[g] as usize][GOLD_DIRECTIONS[i]] = SHORT;
            i += 1;
        }
        g += 1;
    }
    let mut d = 0;
    while d < 8 {
        let straight = d < 4;
        black[KING as usize][d] = SHORT;
        black[BISHOP as usize][d] = if straight { NONE } else { LONG };
        black[ROOK as usize][d] = if straight { LONG } else { NONE };
        black[HORSE as usize][d] = if straight { SHORT } else { LONG };
        black[DRAGON as usize][d] = if straight { LONG } else { SHORT };
        d += 1;
    }

    let mut white = [[NONE; DIRECTIONS]; 14];
    let mut t = 0;
    while t < 14 {
        let mut d = 0;
        while d < DIRECTIONS {
            white[t][d] = black[t][FLIP[d]];
            d += 1;
        }
        t += 1;
    }
    [black, white]
}

/// 盤の中の升なら添字を返す
const fn square_at(x: i8, y: i8) -> Option<u8> {
    if x >= 0 && x < 9 && y >= 0 && y < 9 {
        Some((y * 9 + x) as u8)
    } else {
        None
    }
}

/// vectorToDirectionAndDistance。向きと距離を返す。どの向きでもなければ None
const fn vector_to_direction(dx: i8, dy: i8) -> Option<(usize, i8)> {
    match (dx, dy) {
        (1, -2) => return Some((RIGHT_UP_KNIGHT, 1)),
        (-1, -2) => return Some((LEFT_UP_KNIGHT, 1)),
        (1, 2) => return Some((RIGHT_DOWN_KNIGHT, 1)),
        (-1, 2) => return Some((LEFT_DOWN_KNIGHT, 1)),
        _ => {}
    }
    if dx != 0 && dy != 0 && dx.abs() != dy.abs() {
        return None;
    }
    let distance = if dy != 0 { dy.abs() } else { dx.abs() };
    let direction = match (dx.signum(), dy.signum()) {
        (-1, -1) => LEFT_UP,
        (0, -1) => UP,
        (1, -1) => RIGHT_UP,
        (-1, 0) => LEFT,
        (1, 0) => RIGHT,
        (-1, 1) => LEFT_DOWN,
        (0, 1) => DOWN,
        (1, 1) => RIGHT_DOWN,
        _ => return None,
    };
    Some((direction, distance))
}

/// 成れる駒種か (isPromotable)
const fn is_promotable(piece_type: u8) -> bool {
    matches!(piece_type, PAWN | LANCE | KNIGHT | SILVER | BISHOP | ROOK)
}

/// 成れる段か (isPromotableRank)
const fn is_promotable_rank(color: u8, rank: u8) -> bool {
    if color == BLACK { rank <= 3 } else { rank >= 7 }
}

/// 行き所の無い段か (isInvalidRank)
const fn is_invalid_rank(color: u8, piece_type: u8, rank: u8) -> bool {
    match (color, piece_type) {
        (BLACK, PAWN | LANCE) => rank == 1,
        (BLACK, KNIGHT) => rank <= 2,
        (WHITE, PAWN | LANCE) => rank == 9,
        (WHITE, KNIGHT) => rank >= 8,
        _ => false,
    }
}

/// USI の升 (筋 '1'..='9', 段 'a'..='i')
const fn usi_square(file: u8, rank: u8) -> Option<u8> {
    if file >= b'1' && file <= b'9' && rank >= b'a' && rank <= b'i' {
        Some(square(file - b'0', rank - b'a' + 1))
    } else {
        None
    }
}

/// USI の打つ駒の文字 (Piece.newBySFEN の 1 文字の鍵)。大文字でも小文字でも駒種は同じ
const fn usi_drop_piece(c: u8) -> Option<u8> {
    match c.to_ascii_uppercase() {
        b'P' => Some(PAWN),
        b'L' => Some(LANCE),
        b'N' => Some(KNIGHT),
        b'S' => Some(SILVER),
        b'G' => Some(GOLD),
        b'B' => Some(BISHOP),
        b'R' => Some(ROOK),
        b'K' => Some(KING),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct Position {
    /// 升の中身 (添字は square())
    pub cells: [u8; 81],
    /// 持駒の枚数 `[手番][駒種]`。駒種は 0..HAND_TYPES。
    /// 玉は持駒に数えない (tsshogi では玉の枚数が数にならず、打つ判定を素通りする)
    pub hands: [[u8; HAND_TYPES]; 2],
    /// 手番
    pub turn: u8,
    /// 手番ごとの、升の添字順で最初の玉 (findKing)。無ければ NO_SQUARE
    kings: [u8; 2],
}

impl Position {
    /// 平手の初期局面 (先手番)
    pub fn hirate() -> Position {
        const BACK: [u8; 9] = [
            LANCE, KNIGHT, SILVER, GOLD, KING, GOLD, SILVER, KNIGHT, LANCE,
        ];
        let mut cells = [0u8; 81];
        for (x, &piece_type) in BACK.iter().enumerate() {
            cells[x] = cell(WHITE, piece_type);
            cells[18 + x] = cell(WHITE, PAWN);
            cells[54 + x] = cell(BLACK, PAWN);
            cells[72 + x] = cell(BLACK, piece_type);
        }
        cells[square(8, 2) as usize] = cell(WHITE, ROOK);
        cells[square(2, 2) as usize] = cell(WHITE, BISHOP);
        cells[square(8, 8) as usize] = cell(BLACK, BISHOP);
        cells[square(2, 8) as usize] = cell(BLACK, ROOK);
        Position::from_parts(cells, [[0; HAND_TYPES]; 2], BLACK)
    }

    /// 升の中身と持駒と手番から局面を組む (試験用)。内部の控え (玉の位置など) はここで作り直す
    pub fn from_parts(cells: [u8; 81], hands: [[u8; HAND_TYPES]; 2], turn: u8) -> Position {
        let mut position = Position {
            cells,
            hands,
            turn,
            kings: [NO_SQUARE; 2],
        };
        position.refresh();
        position
    }

    /// `cells` を直接書き換えたあとに呼ぶ。内部の控え (玉の位置) を作り直す
    pub fn refresh(&mut self) {
        self.kings = [NO_SQUARE; 2];
        for color in [BLACK, WHITE] {
            let king = cell(color, KING);
            if let Some(sq) = self.cells.iter().position(|&c| c == king) {
                self.kings[color as usize] = sq as u8;
            }
        }
    }

    /// 升の添字順で最初の玉の升 (findKing)。無ければ NO_SQUARE
    pub fn king_square(&self, color: u8) -> u8 {
        self.kings[color as usize & 1]
    }

    /// 持駒の枚数。持駒にならない駒種 (玉・成駒) は None
    /// (HandPiece 要件はこのとき常に成立しない)
    pub fn hand_count(&self, color: u8, piece_type: u8) -> Option<u8> {
        if (piece_type as usize) < HAND_TYPES {
            Some(self.hands[color as usize][piece_type as usize])
        } else {
            None
        }
    }

    /// createMoveByUSI 相当。`usi` は lib.rs の「棋譜の符号」の 5 バイト。
    /// 指し手を作れなければ None (合法かどうかはまだ見ない)
    pub fn move_from_usi(&self, usi: &[u8]) -> Option<Move> {
        let byte = |i: usize| usi.get(i).copied().unwrap_or(0);
        let (from, piece_type) = if byte(1) == b'*' {
            (NO_SQUARE, usi_drop_piece(byte(0))?)
        } else {
            let from = usi_square(byte(0), byte(1))?;
            let target = self.cells[from as usize];
            if target == 0 {
                return None;
            }
            (from, cell_type(target))
        };
        let to = usi_square(byte(2), byte(3))?;
        let captured = self.cells[to as usize];
        Some(Move {
            from,
            to,
            piece_type,
            color: self.turn,
            // withPromote は打つ手にも付く (付いた打つ手は isValidMove で落ちる)
            promote: byte(4) == b'+',
            captured: if captured == 0 {
                NO_PIECE
            } else {
                cell_type(captured)
            },
        })
    }

    /// isValidMove 相当
    pub fn is_valid_move(&self, m: &Move) -> bool {
        if m.to >= 81 || m.piece_type > DRAGON {
            return false;
        }
        let turn = self.turn;
        let to = m.to;
        if !m.is_drop() {
            if m.from >= 81 {
                return false;
            }
            let target = self.cells[m.from as usize];
            if target == 0 || cell_color(target) != turn || cell_type(target) != m.piece_type {
                return false;
            }
            if !self.is_movable(m.from, to) {
                return false;
            }
            let captured = self.cells[to as usize];
            if captured != 0 && cell_color(captured) == turn {
                return false;
            }
            if (captured == 0) != (m.captured == NO_PIECE) {
                return false;
            }
            if captured != 0 && cell_type(captured) != m.captured {
                return false;
            }
            if m.promote {
                if !is_promotable(m.piece_type) {
                    return false;
                }
                if !is_promotable_rank(turn, rank_of(m.from))
                    && !is_promotable_rank(turn, rank_of(to))
                {
                    return false;
                }
            } else if is_invalid_rank(turn, m.piece_type, rank_of(to)) {
                return false;
            }
            let checked = if m.piece_type != KING {
                self.is_checked(turn, to, m.from)
            } else {
                self.has_power(to, turn ^ 1, NO_SQUARE, m.from)
            };
            !checked
        } else {
            if m.promote || m.color != turn {
                return false;
            }
            // 玉や成駒は枚数が数にならず、tsshogi ではこの検査を素通りする
            if let Some(0) = self.hand_count(turn, m.piece_type) {
                return false;
            }
            if self.cells[to as usize] != 0 {
                return false;
            }
            if is_invalid_rank(turn, m.piece_type, rank_of(to)) {
                return false;
            }
            if m.piece_type == PAWN && self.pawn_exists(turn, file_of(to)) {
                return false;
            }
            if self.is_checked(turn, to, NO_SQUARE) {
                return false;
            }
            !self.is_pawn_drop_mate(m)
        }
    }

    /// doMove (ignoreValidation) 相当。手番も入れ替える
    pub fn do_move(&mut self, m: &Move) {
        if m.to >= 81 {
            return;
        }
        let turn = self.turn;
        let to = m.to as usize;
        if !m.is_drop() {
            if m.from >= 81 {
                return;
            }
            let from = m.from as usize;
            let target = self.cells[from];
            if target == 0 {
                // tsshogi は何もせず false を返す (手番も変えない)
                return;
            }
            let captured = self.cells[to];
            self.cells[from] = 0;
            self.cells[to] = if m.promote {
                cell(cell_color(target), promoted(cell_type(target)))
            } else {
                target
            };
            let mut kings_moved = cell_type(target) == KING;
            if captured != 0 {
                let captured_type = cell_type(captured);
                if captured_type == KING {
                    kings_moved = true;
                } else {
                    let hand = &mut self.hands[turn as usize][unpromoted(captured_type) as usize];
                    *hand = hand.saturating_add(1);
                }
            }
            if kings_moved {
                self.refresh();
            }
        } else {
            if m.piece_type > DRAGON {
                return;
            }
            if (m.piece_type as usize) < HAND_TYPES {
                let hand = &mut self.hands[turn as usize][m.piece_type as usize];
                *hand = hand.saturating_sub(1);
            }
            let replaced = self.cells[to];
            self.cells[to] = cell(turn, m.piece_type);
            if m.piece_type == KING || (replaced != 0 && cell_type(replaced) == KING) {
                self.refresh();
            }
        }
        self.turn = turn ^ 1;
    }

    /// Position.isMovable。移動元の駒がその升へ動けるか (行き先の駒は見ない)
    fn is_movable(&self, from: u8, to: u8) -> bool {
        let dx = (to % 9) as i8 - (from % 9) as i8;
        let dy = (to / 9) as i8 - (from / 9) as i8;
        let Some((direction, distance)) = vector_to_direction(dx, dy) else {
            return false;
        };
        let piece = self.cells[from as usize];
        if piece == 0 {
            return false;
        }
        match MOVE_TYPE[cell_color(piece) as usize & 1][cell_type(piece) as usize][direction] {
            SHORT => distance == 1,
            LONG => {
                let (sx, sy) = DELTAS[direction];
                let mut x = (from % 9) as i8 + sx;
                let mut y = (from / 9) as i8 + sy;
                while let Some(sq) = square_at(x, y) {
                    if sq == to {
                        return true;
                    }
                    if self.cells[sq as usize] != 0 {
                        return false;
                    }
                    x += sx;
                    y += sy;
                }
                false
            }
            _ => false,
        }
    }

    /// Board.hasPower。`color` の駒が `target` に利いているか。
    /// `filled` の升は駒があるものとして利きを止め、`ignore` の升は空として通す (無ければ NO_SQUARE)
    fn has_power(&self, target: u8, color: u8, filled: u8, ignore: u8) -> bool {
        let tx = (target % 9) as i8;
        let ty = (target / 9) as i8;
        for (direction, &(dx, dy)) in DELTAS.iter().enumerate() {
            let mut x = tx + dx;
            let mut y = ty + dy;
            let mut step = 0;
            while let Some(sq) = square_at(x, y) {
                step += 1;
                if sq == filled {
                    break;
                }
                if sq != ignore {
                    let piece = self.cells[sq as usize];
                    if piece != 0 {
                        if cell_color(piece) == color {
                            let move_type = MOVE_TYPE[color as usize & 1]
                                [cell_type(piece) as usize][REVERSE[direction]];
                            if move_type == LONG || (move_type == SHORT && step == 1) {
                                return true;
                            }
                        }
                        break;
                    }
                }
                // 桂の向きは 2 升目より先で利きになる駒が無い
                if direction >= LEFT_UP_KNIGHT {
                    break;
                }
                x += dx;
                y += dy;
            }
        }
        false
    }

    /// Board.isChecked。`color` の最初の玉に相手の利きがあるか。玉が無ければ false
    fn is_checked(&self, color: u8, filled: u8, ignore: u8) -> bool {
        let king = self.kings[color as usize & 1];
        king != NO_SQUARE && self.has_power(king, color ^ 1, filled, ignore)
    }

    /// pawnExists。その筋に成っていない自分の歩があるか
    fn pawn_exists(&self, color: u8, file: u8) -> bool {
        let pawn = cell(color, PAWN);
        let x = (9 - file) as usize;
        (0..9).any(|y| self.cells[y * 9 + x] == pawn)
    }

    /// Position.isPawnDropMate。歩を打つ前の盤で見る
    fn is_pawn_drop_mate(&self, m: &Move) -> bool {
        if !m.is_drop() || m.piece_type != PAWN {
            return false;
        }
        let forward = if m.color == BLACK { -1 } else { 1 };
        let Some(king_square) = square_at((m.to % 9) as i8, (m.to / 9) as i8 + forward) else {
            return false;
        };
        let king = self.cells[king_square as usize];
        if king == 0 || cell_type(king) != KING || cell_color(king) == m.color {
            return false;
        }
        let king_color = cell_color(king);
        // 逃げ道。玉の升は ignore しないので、玉の陰になる升は安全に見える (tsshogi の癖)
        let kx = (king_square % 9) as i8;
        let ky = (king_square / 9) as i8;
        for &(dx, dy) in &DELTAS[..8] {
            let Some(escape) = square_at(kx + dx, ky + dy) else {
                continue;
            };
            let piece = self.cells[escape as usize];
            if piece != 0 && cell_color(piece) == king_color {
                continue;
            }
            if !self.has_power(escape, m.color, m.to, NO_SQUARE) {
                return false;
            }
        }
        // 玉以外の駒 (二枚目の玉も含む) で歩を取れるか
        !(0..81u8).any(|from| {
            let piece = self.cells[from as usize];
            piece != 0
                && cell_color(piece) == king_color
                && from != king_square
                && self.is_movable(from, m.to)
                && !self.is_checked(king_color, m.to, from)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_types_mirror_black_for_white() {
        assert_eq!(MOVE_TYPE[WHITE as usize][PAWN as usize][DOWN], SHORT);
        assert_eq!(MOVE_TYPE[WHITE as usize][PAWN as usize][UP], NONE);
        assert_eq!(
            MOVE_TYPE[WHITE as usize][KNIGHT as usize][LEFT_DOWN_KNIGHT],
            SHORT
        );
        assert_eq!(MOVE_TYPE[WHITE as usize][GOLD as usize][UP], SHORT);
        assert_eq!(MOVE_TYPE[WHITE as usize][GOLD as usize][LEFT_UP], NONE);
        assert_eq!(MOVE_TYPE[WHITE as usize][SILVER as usize][LEFT_UP], SHORT);
        assert_eq!(MOVE_TYPE[WHITE as usize][SILVER as usize][LEFT], NONE);
    }

    #[test]
    fn vector_to_direction_matches_tsshogi() {
        assert_eq!(vector_to_direction(0, 0), None);
        assert_eq!(vector_to_direction(2, 1), None);
        assert_eq!(vector_to_direction(-1, -2), Some((LEFT_UP_KNIGHT, 1)));
        assert_eq!(vector_to_direction(0, -5), Some((UP, 5)));
        assert_eq!(vector_to_direction(3, 3), Some((RIGHT_DOWN, 3)));
        assert_eq!(vector_to_direction(-4, 0), Some((LEFT, 4)));
    }

    #[test]
    fn hirate_has_kings_on_5a_and_5i() {
        let position = Position::hirate();
        assert_eq!(position.king_square(BLACK), square(5, 9));
        assert_eq!(position.king_square(WHITE), square(5, 1));
        assert_eq!(position.cells[square(8, 8) as usize], cell(BLACK, BISHOP));
        assert_eq!(position.cells[square(2, 2) as usize], cell(WHITE, BISHOP));
    }
}
