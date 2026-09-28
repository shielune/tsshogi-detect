//! 指し手の履歴。src/move-history.ts の MoveHistory と src/position-history.ts の
//! PositionOnlyHistory を写したもの。
//!
//! 要件が履歴に尋ねることは HistoryView にまとめ、本物の履歴 (History) と
//! 局面だけから推す近似 (Approx) の両方で同じ照合を回す。

use crate::board::{
    BISHOP, BLACK, HORSE, KING, Move, NO_PIECE, PAWN, WHITE, cell, promoted, unpromoted,
};

/// 要件と定義の制約が履歴に尋ねること
pub trait HistoryView {
    /// PieceUnmoved: `side` の駒がその升から動いていないか
    fn is_unmoved(&self, side: u8, sq: u8) -> bool;
    /// PieceVisited: `side` の `piece_type` がその升に居たことがあるか
    fn has_visited(&self, side: u8, piece_type: u8, sq: u8) -> bool;
    /// KingIgyoku
    fn igyoku(&self, side: u8) -> bool;
    /// その升の駒が `side` の打った駒のままか (noDrop)
    fn is_dropped(&self, side: u8, sq: u8) -> bool;
    /// 角交換を先に仕掛けた側 (両者とも角を取るまでは None)
    fn bishop_exchange_initiator(&self) -> Option<u8>;
}

/// 打った駒の無い升
const NO_COLOR: u8 = 0xff;

const fn bit(sq: u8) -> u128 {
    1u128 << sq
}

/// MoveHistory 相当。集合と表は升の bit の列で持つ
#[derive(Clone, Debug)]
pub struct History {
    /// `[手番][駒種]` の居たことのある升
    visited: [[u128; 14]; 2],
    /// `[手番]` の動かしたことのある移動元
    touched: [u128; 2],
    /// 升ごとの、打ってから動いていない駒の手番
    dropped: [u8; 81],
    king_moved: [Option<u32>; 2],
    outbreak: Option<u32>,
    bishop_capture: [Option<u32>; 2],
}

impl Default for History {
    fn default() -> Self {
        History {
            visited: [[0; 14]; 2],
            touched: [0; 2],
            dropped: [NO_COLOR; 81],
            king_moved: [None; 2],
            outbreak: None,
            bishop_capture: [None; 2],
        }
    }
}

impl History {
    /// initFromPosition: 盤に居る駒を全部「居たことがある」にした履歴
    pub fn from_cells(cells: &[u8; 81]) -> History {
        let mut history = History::default();
        for (sq, &c) in cells.iter().enumerate() {
            if c != 0 {
                history.visited[(c >> 4) as usize][((c & 0x0f) - 1) as usize] |= bit(sq as u8);
            }
        }
        history
    }

    /// recordMove。doMove の前に呼ぶ
    pub fn record_move(&mut self, m: &Move, ply: u32) {
        let color = m.color as usize;
        if m.is_drop() {
            self.dropped[m.to as usize] = m.color;
        } else {
            self.touched[color] |= bit(m.from);
            if m.piece_type == KING && self.king_moved[color].is_none() {
                self.king_moved[color] = Some(ply);
            }
            self.dropped[m.from as usize] = NO_COLOR;
            self.dropped[m.to as usize] = NO_COLOR;
        }

        self.visited[color][m.piece_type as usize] |= bit(m.to);
        if m.promote {
            self.visited[color][promoted(m.piece_type) as usize] |= bit(m.to);
        }

        if m.captured == NO_PIECE {
            return;
        }
        let basic = unpromoted(m.captured);
        if self.outbreak.is_none() && basic != PAWN && basic != BISHOP {
            self.outbreak = Some(ply);
        }
        if (m.captured == BISHOP || m.captured == HORSE) && self.bishop_capture[color].is_none() {
            self.bishop_capture[color] = Some(ply);
        }
    }

    /// outbreakTurn
    pub fn outbreak(&self) -> Option<u32> {
        self.outbreak
    }
}

impl HistoryView for History {
    fn is_unmoved(&self, side: u8, sq: u8) -> bool {
        self.touched[side as usize] & bit(sq) == 0
    }

    fn has_visited(&self, side: u8, piece_type: u8, sq: u8) -> bool {
        self.visited[side as usize][piece_type as usize] & bit(sq) != 0
    }

    fn igyoku(&self, side: u8) -> bool {
        match (self.king_moved[side as usize], self.outbreak) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(king), Some(outbreak)) => king >= outbreak,
        }
    }

    fn is_dropped(&self, side: u8, sq: u8) -> bool {
        self.dropped[sq as usize] == side
    }

    fn bishop_exchange_initiator(&self) -> Option<u8> {
        match self.bishop_capture {
            [Some(black), Some(white)] => Some(if black <= white { BLACK } else { WHITE }),
            _ => None,
        }
    }
}

/// PositionOnlyHistory 相当。何も動いておらず、居たことがあるのは
/// 平手の初期配置か今の盤に居る駒だけ、と見なす
pub struct Approx<'a> {
    pub hirate: &'a [u8; 81],
    pub cells: &'a [u8; 81],
}

impl HistoryView for Approx<'_> {
    fn is_unmoved(&self, _side: u8, _sq: u8) -> bool {
        true
    }

    fn has_visited(&self, side: u8, piece_type: u8, sq: u8) -> bool {
        let expected = cell(side, piece_type);
        self.hirate[sq as usize] == expected || self.cells[sq as usize] == expected
    }

    fn igyoku(&self, _side: u8) -> bool {
        true
    }

    fn is_dropped(&self, _side: u8, _sq: u8) -> bool {
        false
    }

    fn bishop_exchange_initiator(&self) -> Option<u8> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{GOLD, NO_SQUARE, ROOK, SILVER, square};

    fn board_move(from: u8, to: u8, piece_type: u8, color: u8, captured: u8) -> Move {
        Move {
            from,
            to,
            piece_type,
            color,
            promote: false,
            captured,
        }
    }

    #[test]
    fn records_sources_drops_and_visits() {
        let mut h = History::default();
        let from = square(3, 9);
        let to = square(3, 8);
        h.record_move(&board_move(from, to, SILVER, BLACK, NO_PIECE), 1);
        assert!(!h.is_unmoved(BLACK, from));
        assert!(h.is_unmoved(WHITE, from));
        assert!(h.has_visited(BLACK, SILVER, to));
        assert!(!h.has_visited(WHITE, SILVER, to));

        let drop_to = square(5, 5);
        let drop = Move {
            from: NO_SQUARE,
            to: drop_to,
            piece_type: GOLD,
            color: WHITE,
            promote: false,
            captured: NO_PIECE,
        };
        h.record_move(&drop, 2);
        assert!(h.is_dropped(WHITE, drop_to));
        assert!(!h.is_dropped(BLACK, drop_to));
        // 打った駒が動けば (取られても) 打った印は消える
        h.record_move(&board_move(square(5, 6), drop_to, SILVER, BLACK, GOLD), 3);
        assert!(!h.is_dropped(WHITE, drop_to));
        assert_eq!(h.outbreak(), Some(3));
    }

    #[test]
    fn promotion_visits_both_types() {
        let mut h = History::default();
        let m = Move {
            from: square(2, 4),
            to: square(2, 3),
            piece_type: ROOK,
            color: BLACK,
            promote: true,
            captured: PAWN,
        };
        h.record_move(&m, 5);
        assert!(h.has_visited(BLACK, ROOK, square(2, 3)));
        assert!(h.has_visited(BLACK, crate::board::DRAGON, square(2, 3)));
        // 歩を取っても戦端は開かない
        assert_eq!(h.outbreak(), None);
    }

    #[test]
    fn igyoku_and_bishop_exchange() {
        let mut h = History::default();
        assert!(h.igyoku(BLACK));
        h.record_move(
            &board_move(square(5, 9), square(4, 8), KING, BLACK, NO_PIECE),
            1,
        );
        // 玉が動いたが戦端はまだ
        assert!(!h.igyoku(BLACK));
        assert!(h.igyoku(WHITE));
        h.record_move(
            &board_move(square(2, 2), square(8, 8), BISHOP, WHITE, BISHOP),
            2,
        );
        assert_eq!(h.bishop_exchange_initiator(), None);
        // 角 (馬) は戦端を開かない
        assert_eq!(h.outbreak(), None);
        h.record_move(
            &board_move(square(7, 9), square(8, 8), SILVER, BLACK, HORSE),
            3,
        );
        assert_eq!(h.bishop_exchange_initiator(), Some(WHITE));
        h.record_move(
            &board_move(square(5, 1), square(5, 2), KING, WHITE, NO_PIECE),
            4,
        );
        h.record_move(
            &board_move(square(6, 9), square(6, 8), GOLD, BLACK, SILVER),
            5,
        );
        assert_eq!(h.outbreak(), Some(5));
        assert!(!h.igyoku(BLACK));
        assert!(!h.igyoku(WHITE));
        h.record_move(
            &board_move(square(5, 2), square(5, 3), KING, WHITE, NO_PIECE),
            6,
        );
        // 最初に動いた手数で決まる
        assert!(!h.igyoku(WHITE));
    }

    #[test]
    fn igyoku_when_king_moves_after_outbreak() {
        let mut h = History::default();
        h.record_move(
            &board_move(square(6, 9), square(6, 8), GOLD, BLACK, SILVER),
            3,
        );
        h.record_move(
            &board_move(square(5, 9), square(4, 8), KING, BLACK, NO_PIECE),
            7,
        );
        assert!(h.igyoku(BLACK));
    }

    #[test]
    fn approx_sees_initial_and_current_squares() {
        let mut hirate = [0u8; 81];
        hirate[square(5, 9) as usize] = cell(BLACK, KING);
        let mut cells = [0u8; 81];
        cells[square(4, 8) as usize] = cell(BLACK, KING);
        let approx = Approx {
            hirate: &hirate,
            cells: &cells,
        };
        assert!(approx.has_visited(BLACK, KING, square(5, 9)));
        assert!(approx.has_visited(BLACK, KING, square(4, 8)));
        assert!(!approx.has_visited(WHITE, KING, square(4, 8)));
        assert!(approx.is_unmoved(BLACK, square(5, 9)));
        assert!(approx.igyoku(WHITE));
    }
}
