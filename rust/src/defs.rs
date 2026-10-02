//! 解析済みの定義と、その照合。src/requirements.ts と src/match.ts を写したもの。
//!
//! ここの照合は TS の手続きをそのまま追う素直な形で、差分で回す走査 (plan.rs) とは
//! 別に書いてある。bit 32 の照合用の走査と game-end の判定はこちらを使う。

use crate::FORMAT_VERSION;
use crate::board::{BLACK, Move, NO_PIECE, Position, cell, cell_color, cell_type, square};
use crate::history::HistoryView;

/// 駒種 14 種の bit
const MASK_ALL: i32 = (1 << 14) - 1;

/// 定義視点の升を `side` から見た升に直す (後手は盤を 180 度回す)
pub const fn rotate(sq: u8, side: u8) -> u8 {
    if side == BLACK { sq } else { 80 - sq }
}

/// 要件 1 件。升は定義視点 (回す前) の添字、color は定義視点の 0 自陣 / 1 相手陣
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Req {
    Piece {
        sq: u8,
        piece_type: u8,
        color: u8,
    },
    AnyOf {
        sq: u8,
        mask: u16,
    },
    Empty {
        sq: u8,
    },
    NotOf {
        sq: u8,
        mask: u16,
        color: u8,
    },
    AnyPiece {
        sq: u8,
    },
    InSquares {
        color: u8,
        mask: u16,
        squares: Vec<u8>,
    },
    Anywhere {
        piece_type: u8,
    },
    Hand {
        piece_type: u8,
        min: i32,
    },
    OpponentHand {
        piece_type: u8,
        min: i32,
    },
    Unmoved {
        sq: u8,
    },
    Visited {
        sq: u8,
        piece_type: u8,
    },
    Igyoku,
    NotIgyoku,
}

const fn has_type(mask: u16, piece_type: u8) -> bool {
    mask & (1 << piece_type) != 0
}

impl Req {
    /// isSatisfiedBy
    pub fn holds<H: HistoryView>(&self, pos: &Position, side: u8, h: &H) -> bool {
        let at = |sq: u8| pos.cells[rotate(sq, side) as usize];
        let is = |c: u8, color: u8, mask: u16| {
            c != 0 && cell_color(c) == color && has_type(mask, cell_type(c))
        };
        match *self {
            Req::Piece {
                sq,
                piece_type,
                color,
            } => at(sq) == cell(side ^ color, piece_type),
            Req::AnyOf { sq, mask } => is(at(sq), side, mask),
            Req::Empty { sq } => at(sq) == 0,
            Req::NotOf { sq, mask, color } => {
                let c = at(sq);
                c == 0 || cell_color(c) != side ^ color || !has_type(mask, cell_type(c))
            }
            Req::AnyPiece { sq } => {
                let c = at(sq);
                c != 0 && cell_color(c) == side
            }
            Req::InSquares {
                color,
                mask,
                ref squares,
            } => squares.iter().any(|&sq| is(at(sq), side ^ color, mask)),
            Req::Anywhere { piece_type } => pos.cells.contains(&cell(side, piece_type)),
            // 持駒に無い駒種は tsshogi では NaN になり、どの枚数とも比べて偽
            Req::Hand { piece_type, min } => pos
                .hand_count(side, piece_type)
                .is_some_and(|n| i64::from(n) >= i64::from(min)),
            Req::OpponentHand { piece_type, min } => pos
                .hand_count(side ^ 1, piece_type)
                .is_some_and(|n| i64::from(n) >= i64::from(min)),
            Req::Unmoved { sq } => h.is_unmoved(side, rotate(sq, side)),
            Req::Visited { sq, piece_type } => h.has_visited(side, piece_type, rotate(sq, side)),
            Req::Igyoku => h.igyoku(side),
            Req::NotIgyoku => !h.igyoku(side),
        }
    }

    /// 履歴を見る要件 (isHistoryRequirement)
    pub const fn is_history(&self) -> bool {
        matches!(
            self,
            Req::Unmoved { .. } | Req::Visited { .. } | Req::Igyoku | Req::NotIgyoku
        )
    }

    /// ownPieceSquares: 自分の駒が居るはずの升 (定義視点)
    pub fn own_squares(&self) -> &[u8] {
        match self {
            Req::Piece { sq, color: 0, .. } | Req::AnyOf { sq, .. } | Req::AnyPiece { sq } => {
                std::slice::from_ref(sq)
            }
            Req::InSquares {
                color: 0, squares, ..
            } => squares,
            _ => &[],
        }
    }
}

/// 最終手の取る駒の指定
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capture {
    Any,
    Nothing,
    Pieces { mask: u16, negated: bool },
}

/// 最終手 (`finish:`) 1 件。升は定義視点
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finish {
    pub to: u8,
    pub from: Option<u8>,
    pub drop: bool,
    pub promote: bool,
    pub capture: Option<Capture>,
}

impl Finish {
    /// matchesFinishMove の 1 件ぶん
    pub fn matches(&self, side: u8, m: &Move) -> bool {
        if m.to != rotate(self.to, side) {
            return false;
        }
        let captured = m.captured != NO_PIECE;
        let capture_ok = match self.capture {
            None => true,
            Some(Capture::Any) => captured,
            Some(Capture::Nothing) => !captured,
            Some(Capture::Pieces { mask, negated }) => {
                captured && has_type(mask, m.captured) != negated
            }
        };
        if !capture_ok {
            return false;
        }
        if self.promote && !m.promote {
            return false;
        }
        if self.drop {
            return m.is_drop();
        }
        match self.from {
            None => true,
            Some(from) => !m.is_drop() && m.from == rotate(from, side),
        }
    }
}

/// 角交換の指定
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bishop {
    Own,
    Opponent,
    Any,
    Never,
}

impl Bishop {
    /// 先に角を取った側 `initiator` のもとで `side` に通るか
    pub fn admits(self, initiator: Option<u8>, side: u8) -> bool {
        match (self, initiator) {
            (Bishop::Never, initiator) => initiator.is_none(),
            (_, None) => false,
            (Bishop::Own, Some(initiator)) => initiator == side,
            (Bishop::Opponent, Some(initiator)) => initiator != side,
            (Bishop::Any, Some(_)) => true,
        }
    }
}

/// 定義 1 件
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Def {
    pub name: u32,
    pub category: bool,
    pub game_end: bool,
    pub no_drop: bool,
    pub ply_eq: Option<u32>,
    pub ply_min: Option<u32>,
    pub ply_max: Option<u32>,
    pub bishop: Option<Bishop>,
    pub gate_parent: Option<u32>,
    pub tier: u32,
    pub finish: Vec<Finish>,
    pub reqs: Vec<Req>,
}

impl Def {
    pub fn has_ply(&self) -> bool {
        self.ply_eq.is_some() || self.ply_min.is_some() || self.ply_max.is_some()
    }

    pub fn has_history(&self) -> bool {
        self.reqs.iter().any(Req::is_history)
    }

    pub fn has_finish(&self) -> bool {
        !self.finish.is_empty()
    }

    /// detectDefinitions が局面だけで照らす定義 (履歴の要件は近似の履歴で見る)
    pub fn in_p1(&self) -> bool {
        !self.category
            && !self.game_end
            && !self.has_ply()
            && !self.no_drop
            && !self.has_finish()
            && self.bishop.is_none()
    }

    /// emitAt の 2 段目で本物の履歴と照らす定義
    pub fn in_p2(&self) -> bool {
        !self.category
            && !self.game_end
            && (self.has_ply()
                || self.has_history()
                || self.no_drop
                || self.has_finish()
                || self.bishop.is_some())
    }

    /// satisfiesPlyConstraint
    pub fn satisfies_ply(&self, ply: u32) -> bool {
        self.ply_eq.is_none_or(|eq| eq == ply)
            && self.ply_min.is_none_or(|min| ply >= min)
            && self.ply_max.is_none_or(|max| ply <= max)
    }

    /// 手数の制約を閉区間 `[lo, hi]` にしたもの。lo > hi なら成立しない
    pub fn window(&self) -> (u32, u32) {
        let lo = self.ply_eq.unwrap_or(0).max(self.ply_min.unwrap_or(0));
        let hi = self
            .ply_eq
            .unwrap_or(u32::MAX)
            .min(self.ply_max.unwrap_or(u32::MAX));
        (lo, hi)
    }

    /// matchesDefinition
    pub fn matches<H: HistoryView>(&self, pos: &Position, side: u8, h: &H) -> bool {
        if !self.reqs.iter().all(|req| req.holds(pos, side, h)) {
            return false;
        }
        if self.no_drop
            && self.reqs.iter().any(|req| {
                req.own_squares()
                    .iter()
                    .any(|&sq| h.is_dropped(side, rotate(sq, side)))
            })
        {
            return false;
        }
        self.bishop
            .is_none_or(|bishop| bishop.admits(h.bishop_exchange_initiator(), side))
    }

    /// matchesFinishMove
    pub fn finish_matches(&self, side: u8, m: &Move) -> bool {
        self.finish.is_empty() || self.finish.iter().any(|entry| entry.matches(side, m))
    }
}

/// 定義の列。`names` は名前の数 (nameId はこれ未満)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalog {
    pub defs: Vec<Def>,
    pub names: u32,
}

/// 定義の符号を先頭から読む。範囲の外の値や余った語があれば None
struct Reader<'a> {
    words: &'a [i32],
}

impl Reader<'_> {
    fn next(&mut self) -> Option<i32> {
        let (&word, rest) = self.words.split_first()?;
        self.words = rest;
        Some(word)
    }

    fn int(&mut self, lo: i32, hi: i32) -> Option<i32> {
        self.next().filter(|word| (lo..=hi).contains(word))
    }

    fn flag(&mut self) -> Option<bool> {
        Some(self.int(0, 1)? == 1)
    }

    fn square(&mut self) -> Option<u8> {
        let file = self.int(1, 9)?;
        let rank = self.int(1, 9)?;
        Some(square(file as u8, rank as u8))
    }

    fn piece(&mut self) -> Option<u8> {
        Some(self.int(0, 13)? as u8)
    }

    fn color(&mut self) -> Option<u8> {
        Some(self.int(0, 1)? as u8)
    }

    fn mask(&mut self) -> Option<u16> {
        Some(self.int(0, MASK_ALL)? as u16)
    }

    /// 件数。1 件に少なくとも `min_words` 語要るので、残りの語で足りなければ断る
    fn count(&mut self, min_words: usize) -> Option<usize> {
        let n = self.int(0, i32::MAX)? as usize;
        (n.checked_mul(min_words)? <= self.words.len()).then_some(n)
    }

    /// 手数。フラグが無ければ 0 でなければならない
    fn ply(&mut self, present: bool) -> Option<Option<u32>> {
        let word = self.int(0, i32::MAX)?;
        if present {
            Some(Some(word as u32))
        } else {
            (word == 0).then_some(None)
        }
    }

    fn finish(&mut self) -> Option<Finish> {
        let to = self.square()?;
        let from = match (self.int(0, 9)?, self.int(0, 9)?) {
            (0, 0) => None,
            (file @ 1..=9, rank @ 1..=9) => Some(square(file as u8, rank as u8)),
            _ => return None,
        };
        let drop = self.flag()?;
        let promote = self.flag()?;
        let kind = self.int(0, 3)?;
        let negated = self.flag()?;
        let mask = self.mask()?;
        let capture = match kind {
            3 => Some(Capture::Pieces { mask, negated }),
            _ if negated || mask != 0 => return None,
            0 => None,
            1 => Some(Capture::Any),
            _ => Some(Capture::Nothing),
        };
        Some(Finish {
            to,
            from,
            drop,
            promote,
            capture,
        })
    }

    fn req(&mut self) -> Option<Req> {
        Some(match self.int(1, 13)? {
            1 => {
                let sq = self.square()?;
                Req::Piece {
                    sq,
                    piece_type: self.piece()?,
                    color: self.color()?,
                }
            }
            2 => Req::AnyOf {
                sq: self.square()?,
                mask: self.mask()?,
            },
            3 => Req::Empty { sq: self.square()? },
            4 => {
                let sq = self.square()?;
                Req::NotOf {
                    sq,
                    mask: self.mask()?,
                    color: self.color()?,
                }
            }
            5 => Req::AnyPiece { sq: self.square()? },
            6 => {
                let color = self.color()?;
                let mask = self.mask()?;
                let n = self.count(2)?;
                let squares = (0..n).map(|_| self.square()).collect::<Option<Vec<_>>>()?;
                Req::InSquares {
                    color,
                    mask,
                    squares,
                }
            }
            7 => Req::Anywhere {
                piece_type: self.piece()?,
            },
            8 => Req::Hand {
                piece_type: self.piece()?,
                min: self.int(-i32::MAX, i32::MAX)?,
            },
            9 => Req::Unmoved { sq: self.square()? },
            10 => {
                let sq = self.square()?;
                Req::Visited {
                    sq,
                    piece_type: self.piece()?,
                }
            }
            11 => Req::Igyoku,
            12 => Req::OpponentHand {
                piece_type: self.piece()?,
                min: self.int(-i32::MAX, i32::MAX)?,
            },
            _ => Req::NotIgyoku,
        })
    }

    fn def(&mut self, names: u32) -> Option<Def> {
        let last_name = names as i32 - 1;
        let name = self.int(0, last_name)? as u32;
        let flags = self.int(0, 63)?;
        let ply_eq = self.ply(flags & 8 != 0)?;
        let ply_min = self.ply(flags & 16 != 0)?;
        let ply_max = self.ply(flags & 32 != 0)?;
        let bishop = match self.int(0, 4)? {
            0 => None,
            1 => Some(Bishop::Own),
            2 => Some(Bishop::Opponent),
            3 => Some(Bishop::Any),
            _ => Some(Bishop::Never),
        };
        let gate_parent = match self.int(-1, last_name)? {
            -1 => None,
            parent => Some(parent as u32),
        };
        let tier = self.int(0, i32::MAX)? as u32;
        let finish_count = self.count(9)?;
        let finish = (0..finish_count)
            .map(|_| self.finish())
            .collect::<Option<Vec<_>>>()?;
        let req_count = self.count(1)?;
        let reqs = (0..req_count)
            .map(|_| self.req())
            .collect::<Option<Vec<_>>>()?;
        Some(Def {
            name,
            category: flags & 1 != 0,
            game_end: flags & 2 != 0,
            no_drop: flags & 4 != 0,
            ply_eq,
            ply_min,
            ply_max,
            bishop,
            gate_parent,
            tier,
            finish,
            reqs,
        })
    }
}

/// 1 件の定義が占める最小の語数 (nameId から要件の数まで)
const DEF_MIN_WORDS: usize = 10;

/// 定義の符号を読む。取り決めから外れていれば None
pub fn decode(words: &[i32]) -> Option<Catalog> {
    let mut reader = Reader { words };
    if reader.next()? != FORMAT_VERSION {
        return None;
    }
    let n = reader.count(DEF_MIN_WORDS)?;
    let names = reader.int(0, n as i32)? as u32;
    let defs = (0..n)
        .map(|_| reader.def(names))
        .collect::<Option<Vec<_>>>()?;
    reader.words.is_empty().then_some(Catalog { defs, names })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{BISHOP, GOLD, HORSE, KING, NO_SQUARE, PAWN, ROOK, SILVER, WHITE};
    use crate::history::{Approx, History};

    /// 要件を持たない定義 1 件の符号
    fn one(flags: i32, plies: [i32; 3], tail: &[i32]) -> Vec<i32> {
        let mut words = vec![
            FORMAT_VERSION,
            1,
            1,
            0,
            flags,
            plies[0],
            plies[1],
            plies[2],
            0,
            -1,
            0,
        ];
        words.extend_from_slice(tail);
        words
    }

    #[test]
    fn decodes_a_definition() {
        let words = one(
            8 | 4,
            [7, 0, 0],
            &[1, 5, 5, 0, 0, 0, 0, 3, 1, 1 << PAWN, 2, 1, 5, 9, 7, 0, 11],
        );
        let catalog = decode(&words).unwrap();
        assert_eq!(catalog.names, 1);
        let def = &catalog.defs[0];
        assert_eq!(def.ply_eq, Some(7));
        assert!(def.no_drop);
        assert_eq!(
            def.finish,
            vec![Finish {
                to: square(5, 5),
                from: None,
                drop: false,
                promote: false,
                capture: Some(Capture::Pieces {
                    mask: 1,
                    negated: true
                }),
            }]
        );
        assert_eq!(
            def.reqs,
            vec![
                Req::Piece {
                    sq: square(5, 9),
                    piece_type: KING,
                    color: 0
                },
                Req::Igyoku
            ]
        );
        assert!(!def.in_p1());
        assert!(def.in_p2());
    }

    #[test]
    fn rejects_broken_words() {
        assert!(decode(&[FORMAT_VERSION, 0, 0]).is_some());
        // 版が違う
        assert!(decode(&[FORMAT_VERSION + 1, 0, 0]).is_none());
        // 名前の数が定義の数より多い
        assert!(decode(&[FORMAT_VERSION, 0, 1]).is_none());
        // 余った語
        assert!(decode(&[FORMAT_VERSION, 0, 0, 0]).is_none());
        // 足りない語
        assert!(decode(&one(0, [0, 0, 0], &[0])).is_none());
        assert!(decode(&one(0, [0, 0, 0], &[0, 0])).is_some());
        // 無い手数に値がある
        assert!(decode(&one(0, [3, 0, 0], &[0, 0])).is_none());
        // 知らないフラグ
        assert!(decode(&one(64, [0, 0, 0], &[0, 0])).is_none());
        // 升の外
        assert!(decode(&one(0, [0, 0, 0], &[0, 1, 3, 10, 5])).is_none());
        // from が片方だけ
        assert!(decode(&one(0, [0, 0, 0], &[1, 5, 5, 3, 0, 0, 0, 0, 0, 0, 0])).is_none());
        // 取る駒を指定していないのに駒の bit がある
        assert!(decode(&one(0, [0, 0, 0], &[1, 5, 5, 0, 0, 0, 0, 1, 0, 1, 0])).is_none());
        // 知らない要件
        assert!(decode(&one(0, [0, 0, 0], &[0, 1, 12])).is_none());
        // 件数が残りの語より多い
        assert!(decode(&one(0, [0, 0, 0], &[0, 1, 6, 0, 0, 5, 1, 1])).is_none());
        // 名前の番号が名前の数を超える
        let mut words = one(0, [0, 0, 0], &[0, 0]);
        words[3] = 1;
        assert!(decode(&words).is_none());
    }

    #[test]
    fn requirements_follow_the_side() {
        let pos = Position::hirate();
        let h = History::from_cells(&pos.cells);
        let king = Req::Piece {
            sq: square(5, 9),
            piece_type: KING,
            color: 0,
        };
        assert!(king.holds(&pos, BLACK, &h));
        assert!(king.holds(&pos, WHITE, &h));
        let their_rook = Req::Piece {
            sq: square(2, 8),
            piece_type: ROOK,
            color: 1,
        };
        assert!(!their_rook.holds(&pos, BLACK, &h));
        let their_rook = Req::Piece {
            sq: square(8, 2),
            piece_type: ROOK,
            color: 1,
        };
        assert!(their_rook.holds(&pos, BLACK, &h));
        let not_bishop = Req::NotOf {
            sq: square(8, 8),
            mask: 1 << BISHOP,
            color: 0,
        };
        assert!(!not_bishop.holds(&pos, WHITE, &h));
        let silvers = Req::InSquares {
            color: 0,
            mask: 1 << SILVER,
            squares: vec![square(5, 5), square(7, 9)],
        };
        assert!(silvers.holds(&pos, WHITE, &h));
        assert!(
            !Req::InSquares {
                color: 0,
                mask: 0x3fff,
                squares: vec![]
            }
            .holds(&pos, BLACK, &h)
        );
        assert!(
            Req::Hand {
                piece_type: GOLD,
                min: 0
            }
            .holds(&pos, BLACK, &h)
        );
        assert!(
            !Req::Hand {
                piece_type: GOLD,
                min: 1
            }
            .holds(&pos, BLACK, &h)
        );
        // 持駒に無い駒種は負の枚数とも比べて偽
        assert!(
            !Req::Hand {
                piece_type: KING,
                min: -5
            }
            .holds(&pos, BLACK, &h)
        );
        assert!(Req::Anywhere { piece_type: KING }.holds(&pos, WHITE, &h));
        assert!(!Req::Anywhere { piece_type: HORSE }.holds(&pos, WHITE, &h));
    }

    #[test]
    fn approx_history_sees_only_squares() {
        let pos = Position::hirate();
        let approx = Approx {
            hirate: &pos.cells,
            cells: &pos.cells,
        };
        assert!(Req::Unmoved { sq: square(5, 5) }.holds(&pos, BLACK, &approx));
        assert!(
            Req::Visited {
                sq: square(2, 8),
                piece_type: ROOK
            }
            .holds(&pos, BLACK, &approx)
        );
        // 後手から見た 2八 は 8二 で、そこには後手の飛車が居る
        assert!(
            Req::Visited {
                sq: square(2, 8),
                piece_type: ROOK
            }
            .holds(&pos, WHITE, &approx)
        );
        assert!(
            !Req::Visited {
                sq: square(2, 8),
                piece_type: BISHOP
            }
            .holds(&pos, WHITE, &approx)
        );
        assert!(Req::Igyoku.holds(&pos, WHITE, &approx));
    }

    #[test]
    fn finish_moves_check_in_order() {
        let m = Move {
            from: NO_SQUARE,
            to: 80 - square(5, 4),
            piece_type: PAWN,
            color: WHITE,
            promote: false,
            captured: NO_PIECE,
        };
        let drop = Finish {
            to: square(5, 4),
            from: Some(square(5, 6)),
            drop: true,
            promote: false,
            capture: Some(Capture::Nothing),
        };
        assert!(drop.matches(WHITE, &m));
        assert!(!drop.matches(BLACK, &m));
        let board = Finish {
            drop: false,
            ..drop.clone()
        };
        assert!(!board.matches(WHITE, &m));
        let capture = Finish {
            from: None,
            drop: false,
            capture: Some(Capture::Pieces {
                mask: 1 << BISHOP,
                negated: false,
            }),
            ..drop
        };
        let takes_horse = Move {
            from: 80 - square(5, 6),
            captured: HORSE,
            ..m
        };
        assert!(!capture.matches(WHITE, &takes_horse));
        let takes_bishop = Move {
            captured: BISHOP,
            ..takes_horse
        };
        assert!(capture.matches(WHITE, &takes_bishop));
    }

    #[test]
    fn ply_window_matches_the_constraint() {
        let mut def = decode(&one(8 | 16 | 32, [5, 3, 9], &[0, 0]))
            .unwrap()
            .defs
            .remove(0);
        assert_eq!(def.window(), (5, 5));
        def.ply_eq = None;
        assert_eq!(def.window(), (3, 9));
        for ply in 0..12 {
            let (lo, hi) = def.window();
            assert_eq!(def.satisfies_ply(ply), (lo..=hi).contains(&ply));
        }
    }

    #[test]
    fn bishop_exchange_sides() {
        assert!(Bishop::Never.admits(None, BLACK));
        assert!(!Bishop::Never.admits(Some(BLACK), BLACK));
        assert!(!Bishop::Any.admits(None, BLACK));
        assert!(Bishop::Own.admits(Some(WHITE), WHITE));
        assert!(!Bishop::Own.admits(Some(WHITE), BLACK));
        assert!(Bishop::Opponent.admits(Some(WHITE), BLACK));
    }
}
