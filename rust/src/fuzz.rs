//! 差分で回す走査を、TS をそのまま写した走査 (options の bit 32) と突き合わせる。
//! 棋譜はでたらめな合法手で指し、定義はその棋譜に現れた局面と指し手から作るので、
//! 成り立つものと成り立たないものが混ざる。

use crate::board::{
    BLACK, HAND_TYPES, KING, Move, NO_PIECE, Position, WHITE, cell_color, cell_type, file_of,
    rank_of,
};
use crate::defs::{Bishop, Capture, Catalog, Def, Finish, Req, rotate};
use crate::scan::{MOVE_BYTES, NAIVE, Scanner, parse_output};

/// xorshift64*
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u32) -> u32 {
        (self.next() >> 32) as u32 % n
    }

    fn chance(&mut self, percent: u32) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u32) as usize]
    }
}

fn usi_square(sq: u8) -> [u8; 2] {
    [b'0' + file_of(sq), b'a' + rank_of(sq) - 1]
}

/// 手番の側の、tsshogi が通す指し手をすべて USI の 5 バイトで
fn legal_moves(pos: &Position, rng: &mut Rng) -> Vec<[u8; MOVE_BYTES]> {
    let mut usis = Vec::new();
    let push = |usi: [u8; MOVE_BYTES], usis: &mut Vec<[u8; MOVE_BYTES]>| {
        if pos
            .move_from_usi(&usi)
            .is_some_and(|m| pos.is_valid_move(&m))
        {
            usis.push(usi);
        }
    };
    for from in 0..81u8 {
        let c = pos.cells[from as usize];
        if c == 0 || cell_color(c) != pos.turn {
            continue;
        }
        for to in 0..81u8 {
            let [f, r] = usi_square(from);
            let [tf, tr] = usi_square(to);
            push([f, r, tf, tr, 0], &mut usis);
            push([f, r, tf, tr, b'+'], &mut usis);
        }
    }
    // 玉を打つ手も tsshogi は通すが、盤がおかしくなるのでたまにだけ
    let letters: &[u8] = if rng.chance(2) {
        b"PLNSGBRK"
    } else {
        b"PLNSGBR"
    };
    for &letter in letters {
        for to in 0..81u8 {
            let [tf, tr] = usi_square(to);
            push([letter, b'*', tf, tr, 0], &mut usis);
        }
    }
    usis
}

/// 棋譜に現れた局面 1 つ
struct Snapshot {
    pos: Position,
    ply: u32,
    last: Move,
}

/// でたらめな棋譜。ときどき不正な手を挟み、その後ろにも手を続ける
fn random_game(rng: &mut Rng, snapshots: &mut Vec<Snapshot>) -> Vec<u8> {
    let mut pos = Position::hirate();
    let mut bytes = Vec::new();
    let plies = rng.below(90);
    for ply in 1..=plies {
        let moves = legal_moves(&pos, rng);
        if moves.is_empty() {
            break;
        }
        let usi = rng.pick(&moves);
        let m = pos.move_from_usi(&usi).unwrap();
        pos.do_move(&m);
        bytes.extend_from_slice(&usi);
        if rng.chance(15) {
            snapshots.push(Snapshot {
                pos: pos.clone(),
                ply,
                last: m,
            });
        }
    }
    if rng.chance(10) {
        // 動かせない駒を動かす手と、読めない手
        bytes.extend_from_slice(if rng.chance(50) { b"5e5d\0" } else { b"zz99+" });
        bytes.extend_from_slice(b"7g7f\0");
    }
    bytes
}

fn mask_with(rng: &mut Rng, piece_type: u8) -> u16 {
    (rng.below(1 << 14) as u16) | 1 << piece_type
}

fn mask_without(rng: &mut Rng, piece_type: u8) -> u16 {
    (rng.below(1 << 14) as u16) & !(1 << piece_type)
}

/// 局面 `pos` を陣営 `side` から見て、成り立つ (ことの多い) 要件を 1 つ
fn requirement(rng: &mut Rng, pos: &Position, side: u8) -> Req {
    let q = rng.below(81) as u8;
    let sq = rotate(q, side);
    let c = pos.cells[q as usize];
    match rng.below(12) {
        0 => Req::Hand {
            piece_type: rng.below(9) as u8,
            min: rng.below(4) as i32 - 1,
        },
        1 => Req::Unmoved { sq },
        2 => {
            let piece_type = if c != 0 && cell_color(c) == side {
                cell_type(c)
            } else {
                rng.below(14) as u8
            };
            Req::Visited { sq, piece_type }
        }
        3 => Req::Igyoku,
        4 => {
            let piece_type = if c != 0 && cell_color(c) == side {
                cell_type(c)
            } else {
                rng.below(14) as u8
            };
            Req::Anywhere { piece_type }
        }
        5 => {
            let (color, mask) = if c == 0 {
                (rng.below(2) as u8, rng.below(1 << 14) as u16)
            } else {
                (cell_color(c) ^ side, mask_with(rng, cell_type(c)))
            };
            let mut squares = vec![sq];
            for _ in 0..rng.below(4) {
                squares.push(rng.below(81) as u8);
            }
            Req::InSquares {
                color,
                mask,
                squares,
            }
        }
        _ if c == 0 => {
            if rng.chance(70) {
                Req::Empty { sq }
            } else {
                Req::NotOf {
                    sq,
                    mask: rng.below(1 << 14) as u16,
                    color: rng.below(2) as u8,
                }
            }
        }
        _ => {
            let (color, piece_type) = (cell_color(c) ^ side, cell_type(c));
            match rng.below(5) {
                0 if color == 0 => Req::AnyOf {
                    sq,
                    mask: mask_with(rng, piece_type),
                },
                1 if color == 0 => Req::AnyPiece { sq },
                2 => {
                    if rng.chance(50) {
                        Req::NotOf {
                            sq,
                            mask: mask_without(rng, piece_type),
                            color,
                        }
                    } else {
                        Req::NotOf {
                            sq,
                            mask: rng.below(1 << 14) as u16,
                            color: color ^ 1,
                        }
                    }
                }
                _ => Req::Piece {
                    sq,
                    piece_type,
                    color,
                },
            }
        }
    }
}

/// 局面 `snap` の最後の手から最終手の指定を 1 つ
fn finish(rng: &mut Rng, snap: &Snapshot) -> Finish {
    let m = snap.last;
    let side = m.color;
    let capture = match rng.below(5) {
        0 => None,
        1 => Some(Capture::Any),
        2 => Some(Capture::Nothing),
        _ => Some(Capture::Pieces {
            mask: if m.captured == NO_PIECE {
                rng.below(1 << 14) as u16
            } else {
                mask_with(rng, m.captured)
            },
            negated: rng.chance(30),
        }),
    };
    Finish {
        to: rotate(
            if rng.chance(85) {
                m.to
            } else {
                rng.below(81) as u8
            },
            side,
        ),
        from: if m.is_drop() || rng.chance(50) {
            None
        } else {
            Some(rotate(m.from, side))
        },
        drop: m.is_drop() && rng.chance(70),
        promote: m.promote && rng.chance(70),
        capture,
    }
}

fn ply_near(rng: &mut Rng, ply: u32) -> u32 {
    (ply + rng.below(7)).saturating_sub(3)
}

fn random_catalog(rng: &mut Rng, snapshots: &[Snapshot]) -> Catalog {
    let count = 1 + rng.below(40);
    let names = 1 + rng.below(count);
    let hirate = Position::hirate();
    let defs = (0..count)
        .map(|_| {
            let snap = if snapshots.is_empty() || rng.chance(10) {
                None
            } else {
                Some(&snapshots[rng.below(snapshots.len() as u32) as usize])
            };
            let (pos, ply) = snap.map_or((&hirate, 1), |snap| (&snap.pos, snap.ply));
            let side = snap.map_or(rng.below(2) as u8, |snap| {
                if rng.chance(70) {
                    snap.last.color
                } else {
                    snap.last.color ^ 1
                }
            });
            let reqs = (0..rng.below(6))
                .map(|_| requirement(rng, pos, side))
                .collect();
            let finish = match snap {
                Some(snap) if rng.chance(20) => {
                    (0..1 + rng.below(2)).map(|_| finish(rng, snap)).collect()
                }
                _ => Vec::new(),
            };
            let window = rng.chance(25);
            Def {
                name: rng.below(names),
                category: rng.chance(5),
                game_end: rng.chance(10),
                no_drop: rng.chance(15),
                ply_eq: (window && rng.chance(40)).then(|| ply_near(rng, ply)),
                ply_min: (window && rng.chance(50)).then(|| ply_near(rng, ply)),
                ply_max: (window && rng.chance(50)).then(|| ply_near(rng, ply) + rng.below(20)),
                bishop: match rng.below(12) {
                    0 => Some(Bishop::Own),
                    1 => Some(Bishop::Opponent),
                    2 => Some(Bishop::Any),
                    3 => Some(Bishop::Never),
                    _ => None,
                },
                gate_parent: rng.chance(40).then(|| rng.below(names)),
                tier: rng.below(4),
                finish,
                reqs,
            }
        })
        .collect();
    Catalog { defs, names }
}

#[test]
fn incremental_matches_naive() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut snapshots = Vec::new();
    let games: Vec<Vec<u8>> = (0..24)
        .map(|_| random_game(&mut rng, &mut snapshots))
        .collect();
    let moves: Vec<u8> = games.concat();
    let lens: Vec<u32> = games
        .iter()
        .map(|game| (game.len() / MOVE_BYTES) as u32)
        .collect();
    // 角交換や捕獲の起きた局面が混ざっていること
    assert!(
        snapshots
            .iter()
            .any(|snap| snap.pos.hands.iter().flatten().any(|&n| n > 0))
    );

    let mut found = 0;
    for _ in 0..60 {
        let mut scanner = Scanner::new(random_catalog(&mut rng, &snapshots));
        for options in 0..NAIVE {
            let mut incremental = Vec::new();
            scanner
                .scan(&moves, &lens, options, &mut incremental)
                .unwrap();
            let mut naive = Vec::new();
            scanner
                .scan(&moves, &lens, options | NAIVE, &mut naive)
                .unwrap();
            assert_eq!(
                incremental,
                naive,
                "options {options}: {:?}",
                scanner.catalog()
            );
            let results = parse_output(&incremental, games.len(), options);
            found += results.iter().map(|r| r.detections.len()).sum::<usize>();
            for result in &results {
                // 同じ鍵は 1 局に 1 度きり
                let mut keys: Vec<(u32, u8)> = result
                    .detections
                    .iter()
                    .chain(result.dropped.iter().flatten())
                    .map(|d| (scanner.catalog().defs[d.def as usize].name, d.side))
                    .collect();
                let total = keys.len();
                keys.sort_unstable();
                keys.dedup();
                assert_eq!(keys.len(), total);
                assert!(
                    result
                        .detections
                        .iter()
                        .all(|d| d.side == BLACK || d.side == WHITE)
                );
            }
        }
    }
    // でたらめでも成り立つものが十分に出ていること
    assert!(found > 10_000, "only {found} detections");
}

#[test]
fn king_drops_keep_the_scan_consistent() {
    // 玉を打つ手を含む棋譜でも、盤の中身の数は崩れない
    let mut rng = Rng(7);
    let mut pos = Position::hirate();
    let mut bytes = Vec::new();
    for _ in 0..40 {
        let moves = legal_moves(&pos, &mut rng);
        let usi = rng.pick(&moves);
        pos.do_move(&pos.move_from_usi(&usi).unwrap());
        bytes.extend_from_slice(&usi);
    }
    bytes.extend_from_slice(b"K*5e\0");
    let catalog = Catalog {
        defs: vec![Def {
            name: 0,
            category: false,
            game_end: false,
            no_drop: false,
            ply_eq: None,
            ply_min: None,
            ply_max: None,
            bishop: None,
            gate_parent: None,
            tier: 0,
            finish: Vec::new(),
            reqs: vec![Req::Anywhere { piece_type: KING }],
        }],
        names: 1,
    };
    let mut scanner = Scanner::new(catalog);
    let lens = [(bytes.len() / MOVE_BYTES) as u32];
    let (mut a, mut b) = (Vec::new(), Vec::new());
    scanner.scan(&bytes, &lens, 16, &mut a).unwrap();
    scanner.scan(&bytes, &lens, 16 | NAIVE, &mut b).unwrap();
    assert_eq!(a, b);
    assert_eq!(HAND_TYPES, 7);
}
