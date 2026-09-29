//! 差分で回す走査のための、定義を陣営ごとの照合の形に直したものと索引。
//!
//! 定義 1 件から、局面だけで照らす段 (近似の履歴) と本物の履歴で照らす段の
//! 照合をそれぞれ作る (両方に入る定義は 2 つになる)。どちらも升の照合は
//! 「その升に置けるものの bit」にしておき、索引は「何が変わったら照らし直すか」で引く。
//!
//! 照らし直さなくてよい理由は、成り立たない条件が成り立つ側へ変わる道がどれかの索引に
//! 載っていることにある。駒が動かずにいること、居玉、角交換をしないこと、持駒が減ること、
//! 打った駒が残ることは、成り立たない側へしか動かない。

use crate::board::{BLACK, DRAGON, HAND_TYPES, Position, WHITE, cell};
use crate::defs::{Bishop, Catalog, Def, Req, rotate};
use crate::history::{History, HistoryView};

/// 升の中身 32 通りのうち、`types` に bit の立った駒種で手番 `color` のもの
fn accept(color: u8, types: u16) -> u32 {
    (0..=DRAGON)
        .filter(|&t| types & (1 << t) != 0)
        .fold(0, |bits, t| bits | 1 << cell(color, t))
}

const ALL_TYPES: u16 = (1 << 14) - 1;

/// 升の照合に載らない要件
#[derive(Clone, Debug)]
pub enum Extra {
    /// どれかの升に `accept` のどれかがある
    InSquares {
        accept: u32,
        squares: Box<[u8]>,
    },
    /// 盤のどこかにこの中身がある
    Anywhere {
        cell: u8,
    },
    Hand {
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
}

/// 陣営 1 つぶんの照合。升はすべて回したあとの添字
#[derive(Clone, Debug, Default)]
pub struct Shape {
    /// `(升, その升に置けるものの bit)`。同じ升は 1 つにまとめてある
    pub checks: Box<[(u8, u32)]>,
    pub extras: Box<[Extra]>,
    /// 打った駒のままであってはならない升 (noDrop)
    pub own: Box<[u8]>,
}

/// 照らす段 1 つぶん
#[derive(Clone, Debug)]
pub struct Plan {
    /// 定義の添字
    pub def: u32,
    /// `nameId * 2`。陣営を足すと一度きりの判定の鍵になる
    pub key: u32,
    pub tier: u32,
    /// 照らしてよい手数の閉区間
    pub lo: u32,
    pub hi: u32,
    /// 本物の履歴で照らす段か
    pub real: bool,
    /// 最終手を縛るか (指した側だけ、行き先の升で引く)
    pub finish: bool,
    pub bishop: Option<Bishop>,
    /// `[先手, 後手]`
    pub shapes: [Shape; 2],
}

impl Plan {
    fn new(index: usize, def: &Def, real: bool, hirate: &[u8; 81]) -> Plan {
        let (lo, hi) = if real { def.window() } else { (0, u32::MAX) };
        Plan {
            def: index as u32,
            key: def.name * 2,
            tier: def.tier,
            lo,
            hi,
            real,
            finish: real && def.has_finish(),
            bishop: if real { def.bishop } else { None },
            shapes: [BLACK, WHITE].map(|side| shape(def, side, real, hirate)),
        }
    }

    /// 升の照合 (`checks`) を除いた、最終手と手数を除く残りの照合。升の照合は走査が
    /// 升ごとの数え上げ (`Flips`) で見ているので、ここでは見ない (matchesDefinition と同じになる)
    pub fn holds_beyond_checks(
        &self,
        side: u8,
        pos: &Position,
        counts: &[u16; 32],
        h: &History,
    ) -> bool {
        let shape = &self.shapes[side as usize];
        shape.extras.iter().all(|extra| match *extra {
            Extra::InSquares {
                accept,
                ref squares,
            } => squares
                .iter()
                .any(|&sq| accept & 1 << pos.cells[sq as usize] != 0),
            Extra::Anywhere { cell } => counts[cell as usize] != 0,
            Extra::Hand { piece_type, min } => pos
                .hand_count(side, piece_type)
                .is_some_and(|n| i64::from(n) >= i64::from(min)),
            Extra::Unmoved { sq } => h.is_unmoved(side, sq),
            Extra::Visited { sq, piece_type } => h.has_visited(side, piece_type, sq),
            Extra::Igyoku => h.igyoku(side),
        }) && !shape.own.iter().any(|&sq| h.is_dropped(side, sq))
            && self
                .bishop
                .is_none_or(|bishop| bishop.admits(h.bishop_exchange_initiator(), side))
    }
}

/// 定義を陣営 `side` の照合に直す。`real` でなければ履歴の要件は近似の履歴
/// (PositionOnlyHistory) の答えに置き換える
fn shape(def: &Def, side: u8, real: bool, hirate: &[u8; 81]) -> Shape {
    let mut checks: Vec<(u8, u32)> = Vec::new();
    let mut extras = Vec::new();
    for req in &def.reqs {
        let at = |sq: u8| rotate(sq, side);
        match *req {
            Req::Piece {
                sq,
                piece_type,
                color,
            } => {
                checks.push((at(sq), 1 << cell(side ^ color, piece_type)));
            }
            Req::AnyOf { sq, mask } => checks.push((at(sq), accept(side, mask))),
            Req::Empty { sq } => checks.push((at(sq), 1)),
            Req::NotOf { sq, mask, color } => checks.push((at(sq), !accept(side ^ color, mask))),
            Req::AnyPiece { sq } => checks.push((at(sq), accept(side, ALL_TYPES))),
            Req::InSquares {
                color,
                mask,
                ref squares,
            } => extras.push(Extra::InSquares {
                accept: accept(side ^ color, mask),
                squares: squares.iter().map(|&sq| at(sq)).collect(),
            }),
            Req::Anywhere { piece_type } => extras.push(Extra::Anywhere {
                cell: cell(side, piece_type),
            }),
            Req::Hand { piece_type, min } => extras.push(Extra::Hand { piece_type, min }),
            Req::Unmoved { sq } if real => extras.push(Extra::Unmoved { sq: at(sq) }),
            Req::Visited { sq, piece_type } if real => {
                extras.push(Extra::Visited {
                    sq: at(sq),
                    piece_type,
                });
            }
            Req::Igyoku if real => extras.push(Extra::Igyoku),
            // 近似の履歴: 駒は動いておらず、居玉で、居たことがあるのは初期配置か今の升
            Req::Unmoved { .. } | Req::Igyoku => {}
            Req::Visited { sq, piece_type } => {
                let expected = cell(side, piece_type);
                if hirate[at(sq) as usize] != expected {
                    checks.push((at(sq), 1 << expected));
                }
            }
        }
    }
    checks.sort_unstable_by_key(|&(sq, _)| sq);
    checks.dedup_by(|later, kept| {
        let same = later.0 == kept.0;
        if same {
            kept.1 &= later.1;
        }
        same
    });
    // 全部が成り立たないと成立しないので、順序は答えに効かない。落ちやすいもの
    // (置ける中身が少ない升) を先に見れば、たいていの照合は 1 つめで終わる
    checks.sort_by_key(|&(sq, bits)| (bits.count_ones(), sq));
    let own = if real && def.no_drop {
        let mut own: Vec<u8> = def
            .reqs
            .iter()
            .flat_map(|req| req.own_squares().iter().map(|&sq| rotate(sq, side)))
            .collect();
        own.sort_unstable();
        own.dedup();
        own
    } else {
        Vec::new()
    };
    Shape {
        checks: checks.into(),
        extras: extras.into(),
        own: own.into(),
    }
}

/// 盤の升に入りうる中身の数 (空 + 先後の 14 駒種)
pub const CELL_KINDS: usize = 29;

/// 升の中身 (空は 0、先手 1..=14、後手 17..=30) を 0..29 に詰めた番号
pub const fn dense(c: u8) -> usize {
    if c < 16 { c as usize } else { c as usize - 2 }
}

/// `dense` の逆
const fn sparse(d: usize) -> u8 {
    if d < 15 { d as u8 } else { d as u8 + 2 }
}

/// 升の照合が「どの手で成り立ち・崩れるか」の表。升に置く中身が `old` から `new` に変わったとき、
/// 照合のうち 1 つが成り立たなくなる (`down`) 照合と、成り立つようになる (`up`) 照合を、
/// `(升 * 29 + old) * 29 + new` で引く。
///
/// 走査は照合ごとに「成り立っている升の数」を持ち、この表の通りに足し引きする。
/// 数が升の照合の数に並んだとき、升の形は揃っている。
#[derive(Clone, Debug, Default)]
pub struct Flips {
    down_start: Box<[u32]>,
    down: Box<[u16]>,
    up_start: Box<[u32]>,
    up: Box<[u16]>,
}

impl Flips {
    pub fn key(sq: usize, old: u8, new: u8) -> usize {
        (sq * CELL_KINDS + dense(old)) * CELL_KINDS + dense(new)
    }

    pub fn down(&self, key: usize) -> &[u16] {
        &self.down[self.down_start[key] as usize..self.down_start[key + 1] as usize]
    }

    pub fn up(&self, key: usize) -> &[u16] {
        &self.up[self.up_start[key] as usize..self.up_start[key + 1] as usize]
    }

    /// `checks` は照合ごとの `(升, 置ける中身の bit)`。添字が照合の番号になる。
    ///
    /// 一時の `(番号, 照合)` の配列は作らない (数十万件になり、WASM の線形メモリは縮まないので
    /// 一度膨らむとワーカの数だけ居座る)。同じ列挙を 2 回回し、1 回目で個数を数え、
    /// 2 回目で詰める。
    fn build<'a>(checks: impl Iterator<Item = &'a [(u8, u32)]> + Clone) -> Flips {
        let buckets = 81 * CELL_KINDS * CELL_KINDS;
        // 変わり方 (升, 前の中身, 後の中身) のうち、その照合の成り立ちが変わるものを列挙する
        let each = |visit: &mut dyn FnMut(usize, bool, u16)| {
            for (id, list) in checks.clone().enumerate() {
                let id = u16::try_from(id).expect("照合が 65,535 件を超えた");
                for &(sq, bits) in list {
                    let holds = |d: usize| bits & (1 << sparse(d)) != 0;
                    for old in 0..CELL_KINDS {
                        for new in 0..CELL_KINDS {
                            if holds(old) != holds(new) {
                                let key = (usize::from(sq) * CELL_KINDS + old) * CELL_KINDS + new;
                                visit(key, holds(old), id);
                            }
                        }
                    }
                }
            }
        };
        // [down, up] の順
        let mut start = [vec![0u32; buckets + 1], vec![0u32; buckets + 1]];
        each(&mut |key, down, _| start[usize::from(!down)][key + 1] += 1);
        for table in &mut start {
            for i in 0..buckets {
                table[i + 1] += table[i];
            }
        }
        let mut items = [
            vec![0u16; start[0][buckets] as usize],
            vec![0u16; start[1][buckets] as usize],
        ];
        let mut next = [start[0].clone(), start[1].clone()];
        each(&mut |key, down, id| {
            let side = usize::from(!down);
            items[side][next[side][key] as usize] = id;
            next[side][key] += 1;
        });
        let [down_start, up_start] = start;
        let [down, up] = items;
        Flips {
            down_start: down_start.into(),
            down: down.into(),
            up_start: up_start.into(),
            up: up.into(),
        }
    }
}

/// 升 `sq` に `bits` のどれかが来ると成り立ちうる照合 `id` の、`by_cell_at` への登録
fn accepted_at(sq: u8, bits: u32, id: u32) -> impl Iterator<Item = (u32, u32)> {
    (0..32u32)
        .filter(move |&c| bits & (1 << c) != 0)
        .map(move |c| (u32::from(sq) * 32 + c, id))
}

/// 番号ごとの一覧を 1 本の配列に詰めたもの。一覧の中は、照らしてよい最後の手数 (hi) の
/// 大きい順に並べてあり、`alive` で手数を過ぎたものを尻尾ごと切り捨てて引ける
#[derive(Clone, Debug, Default)]
pub struct Csr {
    start: Box<[u32]>,
    items: Box<[u32]>,
    /// `items` と同じ並びの、その照合の hi
    until: Box<[u32]>,
}

impl Csr {
    /// `(番号, 値)` の組から作る。同じ番号の同じ値は 1 つにする。`hi` は値 (照合の添字) から
    /// 照らしてよい最後の手数を引く
    fn build(buckets: usize, mut pairs: Vec<(u32, u32)>, hi: impl Fn(u32) -> u32) -> Csr {
        pairs.sort_unstable();
        pairs.dedup();
        // 番号ごとに hi の大きい順へ (同じ hi は値の昇順のまま)
        pairs.sort_by_key(|&(bucket, item)| (bucket, std::cmp::Reverse(hi(item))));
        let mut start = vec![0u32; buckets + 1];
        for &(bucket, _) in &pairs {
            start[bucket as usize + 1] += 1;
        }
        for i in 0..buckets {
            start[i + 1] += start[i];
        }
        Csr {
            start: start.into(),
            until: pairs.iter().map(|&(_, item)| hi(item)).collect(),
            items: pairs.into_iter().map(|(_, item)| item).collect(),
        }
    }

    /// 手数 `ply` でまだ照らしてよいもの (hi が ply 以上)
    pub fn alive(&self, bucket: usize, ply: u32) -> &[u32] {
        let range = self.start[bucket] as usize..self.start[bucket + 1] as usize;
        let until = &self.until[range.clone()];
        &self.items[range][..until.partition_point(|&hi| hi >= ply)]
    }
}

/// 陣営 1 つぶんの索引
#[derive(Clone, Debug, Default)]
pub struct SideIndex {
    /// 升 81 → その升の履歴 (居たことのある駒・打った駒) が変わると成り立ちうる照合
    pub by_square: Csr,
    /// 升 81 x 中身 32 (`升 * 32 + 中身`) → その升にその中身が来ると成り立ちうる、升の照合に
    /// 載らない要件 (pieceInSquares)。来た中身を置けない照合は引かない
    pub by_cell_at: Csr,
    /// 升の中身 32 → 盤のどこかにそれを要る照合
    pub by_cell: Csr,
    /// 持駒の駒種 7 → その駒を持つことを要る照合
    pub by_hand: Csr,
    /// 升 81 → 最終手の行き先がその升の照合
    pub by_finish_to: Csr,
}

/// 定義の列から作った照合と索引の一式
#[derive(Clone, Debug)]
pub struct Plans {
    pub plans: Vec<Plan>,
    /// 最終手を縛らず、手数の区間が空でない照合を lo の昇順に
    pub by_lo: Box<[u32]>,
    /// 角交換を要る照合 (最終手を縛るものを除く)
    pub by_bishop: Box<[u32]>,
    pub sides: [SideIndex; 2],
    /// 陣営ごとの、升の照合が動く表 (`Flips`)
    pub flips: [Flips; 2],
    /// 陣営ごとの、照合ごとの升の照合の数
    pub need: [Box<[u8]>; 2],
    /// 陣営ごとの、平手の局面で成り立っている升の照合の数
    pub sat0: [Box<[u8]>; 2],
    /// game-end で照らす定義の添字 (並び順)
    pub game_end: Box<[u32]>,
}

impl Plans {
    pub fn build(catalog: &Catalog, hirate: &[u8; 81]) -> Plans {
        let mut plans = Vec::new();
        for (index, def) in catalog.defs.iter().enumerate() {
            if def.in_p1() {
                plans.push(Plan::new(index, def, false, hirate));
            }
            if def.in_p2() {
                plans.push(Plan::new(index, def, true, hirate));
            }
        }
        // 手数の区間が空の照合はどこからも引かない
        let live = |plan: &Plan| plan.lo <= plan.hi;

        let mut by_lo: Vec<u32> = (0..plans.len() as u32)
            .filter(|&id| live(&plans[id as usize]) && !plans[id as usize].finish)
            .collect();
        by_lo.sort_by_key(|&id| plans[id as usize].lo);
        let by_bishop = (0..plans.len() as u32)
            .filter(|&id| {
                let plan = &plans[id as usize];
                live(plan)
                    && !plan.finish
                    && matches!(
                        plan.bishop,
                        Some(Bishop::Own | Bishop::Opponent | Bishop::Any)
                    )
            })
            .collect();

        let hi = |id: u32| plans[id as usize].hi;
        let sides = [BLACK, WHITE].map(|side| {
            let mut squares = Vec::new();
            let mut cells_at = Vec::new();
            let mut cells = Vec::new();
            let mut hands = Vec::new();
            let mut finish_to = Vec::new();
            for (id, plan) in plans.iter().enumerate() {
                let id = id as u32;
                if !live(plan) {
                    continue;
                }
                if plan.finish {
                    let def = &catalog.defs[plan.def as usize];
                    finish_to.extend(
                        def.finish
                            .iter()
                            .map(|entry| (u32::from(rotate(entry.to, side)), id)),
                    );
                    continue;
                }
                let shape = &plan.shapes[side as usize];
                squares.extend(shape.own.iter().map(|&sq| (u32::from(sq), id)));
                for extra in &shape.extras {
                    match *extra {
                        Extra::InSquares {
                            accept,
                            squares: ref in_squares,
                        } => {
                            for &sq in in_squares {
                                cells_at.extend(accepted_at(sq, accept, id));
                            }
                        }
                        Extra::Visited { sq, .. } => squares.push((u32::from(sq), id)),
                        Extra::Anywhere { cell } => cells.push((u32::from(cell), id)),
                        Extra::Hand { piece_type, .. } if (piece_type as usize) < HAND_TYPES => {
                            hands.push((u32::from(piece_type), id));
                        }
                        Extra::Hand { .. } | Extra::Unmoved { .. } | Extra::Igyoku => {}
                    }
                }
            }
            SideIndex {
                by_square: Csr::build(81, squares, hi),
                by_cell_at: Csr::build(81 * 32, cells_at, hi),
                by_cell: Csr::build(32, cells, hi),
                by_hand: Csr::build(HAND_TYPES, hands, hi),
                by_finish_to: Csr::build(81, finish_to, hi),
            }
        });

        let sides_checks = |side: usize| plans.iter().map(move |plan| &*plan.shapes[side].checks);
        let flips = [0, 1].map(|side| Flips::build(sides_checks(side)));
        let need = [0, 1].map(|side| {
            sides_checks(side)
                .map(|checks| checks.len() as u8)
                .collect::<Box<[u8]>>()
        });
        let sat0 = [0, 1].map(|side| {
            sides_checks(side)
                .map(|checks| {
                    checks
                        .iter()
                        .filter(|&&(sq, bits)| bits & 1 << hirate[usize::from(sq)] != 0)
                        .count() as u8
                })
                .collect::<Box<[u8]>>()
        });

        let game_end = catalog
            .defs
            .iter()
            .enumerate()
            .filter(|(_, def)| def.game_end)
            .map(|(index, _)| index as u32)
            .collect();
        Plans {
            plans,
            by_lo: by_lo.into(),
            by_bishop,
            sides,
            flips,
            need,
            sat0,
            game_end,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{GOLD, KING, SILVER, square};
    use crate::defs::decode;

    #[test]
    fn checks_merge_and_follow_the_side() {
        let catalog = decode(&[
            crate::FORMAT_VERSION,
            1,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            -1,
            0,
            0,
            3,
            1,
            5,
            9,
            KING as i32,
            0,
            4,
            5,
            9,
            1 << GOLD,
            1,
            10,
            4,
            8,
            SILVER as i32,
        ])
        .unwrap();
        let hirate = Position::hirate().cells;
        let plans = Plans::build(&catalog, &hirate);
        // 履歴の要件があるので 2 段とも照らす
        assert_eq!(plans.plans.len(), 2);
        let p1 = &plans.plans[0];
        assert!(!p1.real);
        let black = &p1.shapes[BLACK as usize];
        // 5九の駒と notOf が 1 つにまとまり、4八の通過は今の升の照合になる
        assert_eq!(
            &*black.checks,
            &[
                (square(4, 8), 1 << cell(BLACK, SILVER)),
                (square(5, 9), 1 << cell(BLACK, KING))
            ]
        );
        let white = &p1.shapes[WHITE as usize];
        assert_eq!(white.checks[0], (80 - square(5, 9), 1 << cell(WHITE, KING)));
        let p2 = &plans.plans[1];
        assert!(p2.real);
        assert!(matches!(
            &*p2.shapes[BLACK as usize].extras,
            [Extra::Visited { .. }]
        ));
        // 履歴を見る升は by_square に載る
        let black_index = &plans.sides[BLACK as usize];
        assert!(
            black_index
                .by_square
                .alive(square(4, 8) as usize, 0)
                .contains(&1)
        );
        // 盤の形だけを見る升は、来た中身で数え上げる: 4八に銀が来れば照合 0 の数が増え、
        // 出ていけば減る。銀でない駒が来ても動かない
        let flips = &plans.flips[BLACK as usize];
        let at = square(4, 8) as usize;
        let silver = cell(BLACK, SILVER);
        let gold = cell(BLACK, GOLD);
        assert_eq!(flips.up(Flips::key(at, 0, silver)), &[0]);
        assert_eq!(flips.down(Flips::key(at, silver, 0)), &[0]);
        assert_eq!(flips.up(Flips::key(at, 0, gold)), &[] as &[u16]);
        assert_eq!(flips.down(Flips::key(at, gold, 0)), &[] as &[u16]);
        // 銀から金へは、どちらも置けないものではないので 0 が崩れる
        assert_eq!(flips.down(Flips::key(at, silver, gold)), &[0]);
        // 平手の 4八 は金で、銀の照合は満たさない。5九の玉は満たす。need は升の照合の数
        assert_eq!(plans.need[BLACK as usize][0], 2);
        assert_eq!(plans.sat0[BLACK as usize][0], 1);
        assert_eq!(&*plans.by_lo, &[0, 1]);
    }

    #[test]
    fn alive_cuts_the_tail_past_the_window() {
        // 番号 3 に 3 件。hi は 5, 9, u32::MAX (並びは hi の大きい順になる)
        let his = [0, 5, 9, u32::MAX];
        let csr = Csr::build(4, vec![(3, 1), (3, 2), (3, 3)], |id| his[id as usize]);
        assert_eq!(csr.alive(3, 0), &[3, 2, 1]);
        assert_eq!(csr.alive(3, 5), &[3, 2, 1]);
        assert_eq!(csr.alive(3, 6), &[3, 2]);
        assert_eq!(csr.alive(3, 10), &[3]);
        assert!(csr.alive(2, 0).is_empty());
    }
}
