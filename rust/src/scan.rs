//! 走査本体。src/scan.ts の scanDefinitions と、その後始末 (sift) を写したもの。
//!
//! 既定は差分で回す。1 手ごとに「その手で何が変わったか」を陣営ごとに溜めておき、
//! その陣営を照らす番が来たら、変わったものから引ける照合と、手数の区間に入った照合だけを
//! 照らす。照らさない照合が成り立たないままでいる理由は plan.rs の冒頭に書いてある。
//! options の bit 32 のときは TS 版をそのまま写した回し方 (毎手すべて照らす) にする。

use crate::board::{BLACK, HAND_TYPES, Move, NO_PIECE, Position, WHITE, unpromoted};
use crate::defs::Catalog;
use crate::history::{Approx, History, HistoryView};
use crate::plan::Plans;
use crate::sift::{Detection, Gate, key, order_within_ply};

pub const MOVER_ONLY: u32 = 1;
pub const REQUIRE_PARENT: u32 = 2;
pub const SUPPRESS_GAME_END: u32 = 4;
pub const WITH_DROPPED: u32 = 8;
pub const FINAL_POSITION: u32 = 16;
pub const NAIVE: u32 = 32;
const KNOWN_OPTIONS: u32 = 63;

/// scan の戻り値 (0 が成功)
pub const BAD_HANDLE: u32 = 1;
pub const BAD_GAMES: u32 = 2;
pub const BAD_OPTIONS: u32 = 3;

/// 指し手 1 つの符号の長さ
pub const MOVE_BYTES: usize = 5;

/// 読み込んだ定義と、走査の作業域
#[derive(Clone, Debug)]
pub struct Scanner {
    catalog: Catalog,
    plans: Plans,
    hirate: Position,
    history0: History,
    counts0: [u16; 32],
    /// 親を持つ定義があるか (無ければ親ゲートは素通り)
    gated: bool,
    game: Game,
    work: Work,
    gate: Gate,
    kept: Vec<Detection>,
    dropped: Vec<Detection>,
}

/// 1 局ぶんの盤と履歴
#[derive(Clone, Debug)]
struct Game {
    pos: Position,
    history: History,
    /// 升の中身ごとの、盤に居る数
    counts: [u16; 32],
}

/// 照合の結果を積む作業域。表は定義を読んだときに一度だけ確保する
#[derive(Clone, Debug)]
struct Work {
    /// 鍵 (`nameId * 2 + 陣営`) → 出したか
    seen: Vec<bool>,
    seen_count: usize,
    /// 照合 → 最後に候補へ入れた世代 (1 回の照らしで重ねて入れないため)
    stamp: Vec<u32>,
    generation: u32,
    candidates: Vec<u32>,
    /// 局面だけで照らす段の成立 `(tier, 定義, 陣営)`
    hits1: Vec<(u32, u32, u8)>,
    /// 本物の履歴で照らす段の成立 `(定義, 陣営)`
    hits2: Vec<(u32, u8)>,
    scanned: Vec<Detection>,
}

/// 差分で回すときの、陣営ごとの「照らしていない間に変わったもの」
#[derive(Clone, Copy, Debug, Default)]
struct Pending {
    /// by_lo のどこまで候補に入れたか
    cursor: usize,
    /// 中身か履歴が変わった升
    squares: u128,
    /// 盤に新しく現れた中身
    cells: u32,
    /// 増えた持駒の駒種
    hand: u8,
    /// 角交換を仕掛けた側が決まった
    bishop: bool,
}

impl Work {
    fn emit(&mut self, key: usize, def: u32, side: u8, ply: u32) {
        if self.seen[key] {
            return;
        }
        self.seen[key] = true;
        self.seen_count += 1;
        self.scanned.push(Detection { def, side, ply });
    }
}

impl Scanner {
    pub fn new(catalog: Catalog) -> Scanner {
        let hirate = Position::hirate();
        let plans = Plans::build(&catalog, &hirate.cells);
        let history0 = History::from_cells(&hirate.cells);
        let mut counts0 = [0u16; 32];
        for &c in &hirate.cells {
            counts0[c as usize] += 1;
        }
        let keys = catalog.names as usize * 2;
        Scanner {
            gated: catalog.defs.iter().any(|def| def.gate_parent.is_some()),
            gate: Gate::new(catalog.names),
            work: Work {
                seen: vec![false; keys],
                seen_count: 0,
                stamp: vec![0; plans.plans.len()],
                generation: 0,
                candidates: Vec::new(),
                hits1: Vec::new(),
                hits2: Vec::new(),
                scanned: Vec::new(),
            },
            game: Game {
                pos: hirate.clone(),
                history: history0.clone(),
                counts: counts0,
            },
            catalog,
            plans,
            hirate,
            history0,
            counts0,
            kept: Vec::new(),
            dropped: Vec::new(),
        }
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// 棋譜をまとめて走査し、lib.rs の「出力」の形で `out` に積む。
    /// `moves` は指し手 5 バイトの列、`lens` は局ごとの指し手の数。
    /// 入力が壊れていれば何も積まずに BAD_GAMES / BAD_OPTIONS を返す
    pub fn scan(
        &mut self,
        moves: &[u8],
        lens: &[u32],
        options: u32,
        out: &mut Vec<i32>,
    ) -> Result<(), u32> {
        let total = lens
            .iter()
            .try_fold(0usize, |sum, &n| sum.checked_add(n as usize));
        if total.and_then(|n| n.checked_mul(MOVE_BYTES)) != Some(moves.len()) {
            return Err(BAD_GAMES);
        }
        if options & !KNOWN_OPTIONS != 0 {
            return Err(BAD_OPTIONS);
        }
        let mut rest = moves;
        for &n in lens {
            let (game, tail) = rest.split_at(n as usize * MOVE_BYTES);
            rest = tail;
            self.scan_game(game, options, out);
        }
        Ok(())
    }

    fn scan_game(&mut self, usis: &[u8], options: u32, out: &mut Vec<i32>) {
        self.reset();
        let mover_only = options & MOVER_ONLY != 0;
        let naive = options & NAIVE != 0;
        let mut pending = [Pending::default(); 2];
        let mut legal = 0u32;
        for usi in usis.as_chunks::<MOVE_BYTES>().0 {
            let Some(m) = self.game.pos.move_from_usi(usi) else {
                break;
            };
            if !self.game.pos.is_valid_move(&m) {
                break;
            }
            legal += 1;
            let ply = legal;
            let initiator = self.game.history.bishop_exchange_initiator();
            let old_from = if m.is_drop() {
                0
            } else {
                self.game.pos.cells[m.from as usize]
            };
            let old_to = self.game.pos.cells[m.to as usize];
            // 履歴は doMove の前に記録する (scan.ts と同じ)
            self.game.history.record_move(&m, ply);
            self.game.pos.do_move(&m);
            let counts = &mut self.game.counts;
            let cells = &self.game.pos.cells;
            if !m.is_drop() {
                counts[old_from as usize] -= 1;
                counts[cells[m.from as usize] as usize] += 1;
            }
            counts[old_to as usize] -= 1;
            counts[cells[m.to as usize] as usize] += 1;

            // 出せる鍵を出し尽くしたら、あとは合法手を数えて盤を進めるだけ
            if self.work.seen_count == self.work.seen.len() {
                continue;
            }
            if naive {
                self.emit_naive(ply, &m, mover_only);
                continue;
            }
            let mut squares = 1u128 << m.to;
            if !m.is_drop() {
                squares |= 1u128 << m.from;
            }
            let appeared = 1u32 << cells[m.to as usize];
            let exchanged =
                initiator.is_none() && self.game.history.bishop_exchange_initiator().is_some();
            for p in &mut pending {
                p.squares |= squares;
                p.cells |= appeared;
                p.bishop |= exchanged;
            }
            if m.captured != NO_PIECE {
                let basic = unpromoted(m.captured);
                if (basic as usize) < HAND_TYPES {
                    pending[m.color as usize].hand |= 1 << basic;
                }
            }
            self.emit_incremental(ply, &m, mover_only, &mut pending);
        }
        if legal > 0 {
            self.game_end(legal, options & SUPPRESS_GAME_END != 0);
        }
        self.sift(options & REQUIRE_PARENT != 0);
        self.write(legal, options, out);
    }

    /// 局を始める前に作業域を戻す
    fn reset(&mut self) {
        for d in &self.work.scanned {
            self.work.seen[key(&self.catalog.defs, d)] = false;
        }
        self.work.scanned.clear();
        self.work.seen_count = 0;
        self.game.pos.clone_from(&self.hirate);
        self.game.history.clone_from(&self.history0);
        self.game.counts = self.counts0;
    }

    /// emitAt を差分で回したもの
    fn emit_incremental(
        &mut self,
        ply: u32,
        m: &Move,
        mover_only: bool,
        pending: &mut [Pending; 2],
    ) {
        let Scanner {
            catalog,
            plans,
            game,
            work,
            ..
        } = self;
        let sides: &[u8] = if mover_only {
            std::slice::from_ref(&m.color)
        } else {
            &[BLACK, WHITE]
        };
        work.hits1.clear();
        work.hits2.clear();
        for &side in sides {
            let index = &plans.sides[side as usize];
            let p = &mut pending[side as usize];

            work.generation = work.generation.wrapping_add(1);
            if work.generation == 0 {
                work.stamp.fill(0);
                work.generation = 1;
            }
            let generation = work.generation;
            let stamp = &mut work.stamp;
            let candidates = &mut work.candidates;
            candidates.clear();
            let mut add = |ids: &[u32]| {
                for &id in ids {
                    if stamp[id as usize] != generation {
                        stamp[id as usize] = generation;
                        candidates.push(id);
                    }
                }
            };

            let entered = plans.by_lo[p.cursor..]
                .iter()
                .take_while(|&&id| plans.plans[id as usize].lo <= ply)
                .count();
            add(&plans.by_lo[p.cursor..p.cursor + entered]);
            p.cursor += entered;
            let mut squares = p.squares;
            while squares != 0 {
                add(index.by_square.get(squares.trailing_zeros() as usize));
                squares &= squares - 1;
            }
            let mut cells = p.cells;
            while cells != 0 {
                add(index.by_cell.get(cells.trailing_zeros() as usize));
                cells &= cells - 1;
            }
            let mut hand = p.hand;
            while hand != 0 {
                add(index.by_hand.get(hand.trailing_zeros() as usize));
                hand &= hand - 1;
            }
            if p.bishop {
                add(&plans.by_bishop);
            }
            if side == m.color {
                add(index.by_finish_to.get(m.to as usize));
            }
            *p = Pending {
                cursor: p.cursor,
                ..Pending::default()
            };

            for &id in &work.candidates {
                let plan = &plans.plans[id as usize];
                if ply < plan.lo
                    || ply > plan.hi
                    || work.seen[(plan.key + u32::from(side)) as usize]
                {
                    continue;
                }
                if plan.finish && !catalog.defs[plan.def as usize].finish_matches(side, m) {
                    continue;
                }
                if !plan.holds(side, &game.pos, &game.counts, &game.history) {
                    continue;
                }
                if plan.real {
                    work.hits2.push((plan.def, side));
                } else {
                    work.hits1.push((plan.tier, plan.def, side));
                }
            }
        }
        // 局面だけの段を先に、並び順 (tier, 定義, 陣営) で。本物の履歴の段は定義, 陣営の順
        work.hits1.sort_unstable();
        work.hits2.sort_unstable();
        let defs = &catalog.defs;
        for i in 0..work.hits1.len() {
            let (_, def, side) = work.hits1[i];
            work.emit(
                defs[def as usize].name as usize * 2 + side as usize,
                def,
                side,
                ply,
            );
        }
        for i in 0..work.hits2.len() {
            let (def, side) = work.hits2[i];
            work.emit(
                defs[def as usize].name as usize * 2 + side as usize,
                def,
                side,
                ply,
            );
        }
    }

    /// emitAt をそのまま写したもの (照合用)
    fn emit_naive(&mut self, ply: u32, m: &Move, mover_only: bool) {
        let Scanner {
            catalog,
            hirate,
            game,
            work,
            ..
        } = self;
        let sides: &[u8] = if mover_only {
            std::slice::from_ref(&m.color)
        } else {
            &[BLACK, WHITE]
        };
        let approx = Approx {
            hirate: &hirate.cells,
            cells: &game.pos.cells,
        };
        work.hits1.clear();
        for (index, def) in catalog.defs.iter().enumerate() {
            if !def.in_p1() {
                continue;
            }
            for &side in sides {
                if def.matches(&game.pos, side, &approx) {
                    work.hits1.push((def.tier, index as u32, side));
                }
            }
        }
        // orderDetections は安定な並べ替え
        work.hits1.sort_by_key(|&(tier, _, _)| tier);
        for i in 0..work.hits1.len() {
            let (_, def, side) = work.hits1[i];
            work.emit(
                catalog.defs[def as usize].name as usize * 2 + side as usize,
                def,
                side,
                ply,
            );
        }
        for (index, def) in catalog.defs.iter().enumerate() {
            if !def.in_p2() || (def.has_ply() && !def.satisfies_ply(ply)) {
                continue;
            }
            let finish_sides: &[u8] = if def.has_finish() {
                std::slice::from_ref(&m.color)
            } else {
                sides
            };
            for &side in finish_sides {
                if def.finish_matches(side, m) && def.matches(&game.pos, side, &game.history) {
                    work.emit(
                        def.name as usize * 2 + side as usize,
                        index as u32,
                        side,
                        ply,
                    );
                }
            }
        }
    }

    /// game-end フェーズ。居玉は戦端の手数 (無ければ合法手の数) で出す
    fn game_end(&mut self, legal: u32, suppress: bool) {
        let Scanner {
            catalog,
            plans,
            game,
            work,
            ..
        } = self;
        if plans.game_end.is_empty() {
            return;
        }
        let mut detected = [false; 2];
        for d in &work.scanned {
            detected[d.side as usize] = true;
        }
        let ply = game.history.outbreak().unwrap_or(legal);
        for &index in &plans.game_end {
            let def = &catalog.defs[index as usize];
            for side in [BLACK, WHITE] {
                if suppress && detected[side as usize] {
                    continue;
                }
                if def.matches(&game.pos, side, &game.history) {
                    work.emit(def.name as usize * 2 + side as usize, index, side, ply);
                }
            }
        }
    }

    /// 親ゲートでふるってから、同じ手数の中を並べ替える
    fn sift(&mut self, require_parent: bool) {
        self.kept.clear();
        self.dropped.clear();
        if require_parent && self.gated {
            self.gate.sift(
                &self.catalog.defs,
                &self.work.scanned,
                &mut self.kept,
                &mut self.dropped,
            );
        } else {
            self.kept.extend_from_slice(&self.work.scanned);
        }
        order_within_ply(&self.catalog.defs, &mut self.kept);
    }

    fn write(&self, legal: u32, options: u32, out: &mut Vec<i32>) {
        out.push(legal as i32);
        if options & FINAL_POSITION != 0 {
            let pos = &self.game.pos;
            out.extend(pos.cells.iter().map(|&c| i32::from(c)));
            for color in [BLACK, WHITE] {
                out.extend(pos.hands[color as usize].iter().map(|&n| i32::from(n)));
            }
            out.push(i32::from(pos.turn));
        }
        let triples = |out: &mut Vec<i32>, list: &[Detection]| {
            out.push(list.len() as i32);
            for d in list {
                out.extend([d.def as i32, i32::from(d.side), d.ply as i32]);
            }
        };
        triples(out, &self.kept);
        if options & WITH_DROPPED != 0 {
            triples(out, &self.dropped);
        }
    }
}

/// 1 局の走査結果 (試験で出力を読み戻すためのもの)
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameResult {
    pub legal: u32,
    pub position: Option<Vec<i32>>,
    pub detections: Vec<Detection>,
    pub dropped: Option<Vec<Detection>>,
}

/// 出力を局ごとに読み戻す
#[cfg(test)]
pub fn parse_output(out: &[i32], games: usize, options: u32) -> Vec<GameResult> {
    let mut words = out.iter().copied();
    let mut next = || words.next().expect("output ended early");
    let triples = |next: &mut dyn FnMut() -> i32| {
        let n = next() as usize;
        (0..n)
            .map(|_| Detection {
                def: next() as u32,
                side: next() as u8,
                ply: next() as u32,
            })
            .collect::<Vec<_>>()
    };
    let mut results = Vec::new();
    for _ in 0..games {
        let legal = next() as u32;
        let position =
            (options & FINAL_POSITION != 0).then(|| (0..81 + 7 + 7 + 1).map(|_| next()).collect());
        let detections = triples(&mut next);
        let dropped = (options & WITH_DROPPED != 0).then(|| triples(&mut next));
        results.push(GameResult {
            legal,
            position,
            detections,
            dropped,
        });
    }
    assert!(words.next().is_none(), "output has extra words");
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FORMAT_VERSION;
    use crate::board::{GOLD, KING, PAWN, ROOK, SILVER};
    use crate::defs::decode;

    fn usis(moves: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for usi in moves {
            let mut chunk = [0u8; MOVE_BYTES];
            for (slot, &b) in chunk.iter_mut().zip(usi.as_bytes()) {
                *slot = b;
            }
            bytes.extend_from_slice(&chunk);
        }
        bytes
    }

    fn run(words: &[i32], games: &[&[&str]], options: u32) -> Vec<GameResult> {
        let mut scanner = Scanner::new(decode(words).unwrap());
        let moves: Vec<u8> = games.iter().flat_map(|game| usis(game)).collect();
        let lens: Vec<u32> = games.iter().map(|game| game.len() as u32).collect();
        let mut out = Vec::new();
        scanner.scan(&moves, &lens, options, &mut out).unwrap();
        let results = parse_output(&out, games.len(), options);
        // 差分で回しても、そのまま写しても同じ
        let mut naive = Vec::new();
        scanner
            .scan(&moves, &lens, options | NAIVE, &mut naive)
            .unwrap();
        assert_eq!(out, naive);
        results
    }

    fn at(def: u32, side: u8, ply: u32) -> Detection {
        Detection { def, side, ply }
    }

    /// 定義 1 件の語。`reqs` は要件の数を含めた後ろ半分
    fn def_words(
        name: i32,
        flags: i32,
        plies: [i32; 3],
        gate: i32,
        tier: i32,
        reqs: &[i32],
    ) -> Vec<i32> {
        let mut words = vec![name, flags, plies[0], plies[1], plies[2], 0, gate, tier, 0];
        words.extend_from_slice(reqs);
        words
    }

    fn catalog(names: i32, defs: &[Vec<i32>]) -> Vec<i32> {
        let mut words = vec![FORMAT_VERSION, defs.len() as i32, names];
        for def in defs {
            words.extend_from_slice(def);
        }
        words
    }

    #[test]
    fn detects_the_first_ply_on_both_sides() {
        // 7六歩 (先手視点) が立った最初の手。後手は 3四歩で同じ形になる
        let words = catalog(
            1,
            &[def_words(
                0,
                0,
                [0; 3],
                -1,
                0,
                &[1, 1, 7, 6, PAWN as i32, 0],
            )],
        );
        let results = run(&words, &[&["7g7f", "3c3d", "2g2f"]], 0);
        assert_eq!(results[0].legal, 3);
        assert_eq!(results[0].detections, [at(0, 0, 1), at(0, 1, 2)]);
        // 指した側だけにしても同じ手で付く
        let results = run(&words, &[&["7g7f", "3c3d"]], MOVER_ONLY);
        assert_eq!(results[0].detections, [at(0, 0, 1), at(0, 1, 2)]);
    }

    #[test]
    fn mover_only_waits_for_the_side_to_move() {
        // 2六が空いている形は平手から両陣営で成り立つ。指した側だけなら後手は 2 手目に付く
        let words = catalog(1, &[def_words(0, 0, [0; 3], -1, 0, &[1, 3, 2, 6])]);
        let both = run(&words, &[&["7g7f", "3c3d"]], 0);
        assert_eq!(both[0].detections, [at(0, 0, 1), at(0, 1, 1)]);
        let mover = run(&words, &[&["7g7f", "3c3d"]], MOVER_ONLY);
        assert_eq!(mover[0].detections, [at(0, 0, 1), at(0, 1, 2)]);
    }

    #[test]
    fn stops_at_the_first_illegal_move() {
        let words = catalog(
            1,
            &[def_words(
                0,
                0,
                [0; 3],
                -1,
                0,
                &[1, 1, 7, 6, PAWN as i32, 0],
            )],
        );
        let results = run(
            &words,
            &[&["7g7f", "7g7f", "3c3d"], &[], &["7g7f"]],
            FINAL_POSITION,
        );
        assert_eq!(results[0].legal, 1);
        assert_eq!(results[1].legal, 0);
        assert!(results[1].detections.is_empty());
        let position = results[0].position.as_ref().unwrap();
        // 1 手指した後の手番は後手
        assert_eq!(position[81 + 14], WHITE as i32);
        assert_eq!(results[2].detections, [at(0, 0, 1)]);
    }

    #[test]
    fn ply_windows_and_game_end() {
        // 0: 2手目に 5一玉 (後手の 5九玉) が居る。1: 居玉 (game-end)。2: 金が 5八に来る
        let words = catalog(
            3,
            &[
                def_words(0, 8, [2, 0, 0], -1, 0, &[1, 1, 5, 9, KING as i32, 0]),
                def_words(1, 2, [0; 3], -1, 1, &[1, 11]),
                def_words(2, 0, [0; 3], -1, 0, &[1, 1, 5, 8, GOLD as i32, 0]),
            ],
        );
        let results = run(&words, &[&["7g7f", "3c3d", "8h2b+", "3a2b", "6i5h"]], 0);
        // 角交換は戦端ではないので、居玉は合法手の数 (5 手目) で出る
        assert_eq!(
            results[0].detections,
            [
                at(0, 0, 2),
                at(0, 1, 2),
                at(2, 0, 5),
                at(1, 0, 5),
                at(1, 1, 5)
            ]
        );
        // 検出済みの陣営には居玉を出さない
        let results = run(
            &words,
            &[&["7g7f", "3c3d", "8h2b+", "3a2b", "6i5h"]],
            SUPPRESS_GAME_END,
        );
        assert_eq!(
            results[0].detections,
            [at(0, 0, 2), at(0, 1, 2), at(2, 0, 5)]
        );
    }

    #[test]
    fn parents_gate_their_children() {
        // 0: 7六歩。1: 親 0 で 2六歩。2: 親 1 で 5八金
        let words = catalog(
            3,
            &[
                def_words(0, 0, [0; 3], -1, 1, &[1, 1, 7, 6, PAWN as i32, 0]),
                def_words(1, 0, [0; 3], 0, 0, &[1, 1, 2, 6, PAWN as i32, 0]),
                def_words(2, 0, [0; 3], 1, 0, &[1, 1, 5, 8, GOLD as i32, 0]),
            ],
        );
        let game: &[&str] = &["2g2f", "9c9d", "7g7f", "9d9e", "6i5h"];
        let plain = run(&words, &[game], WITH_DROPPED);
        assert_eq!(plain[0].detections, [at(1, 0, 1), at(0, 0, 3), at(2, 0, 5)]);
        assert_eq!(plain[0].dropped.as_deref(), Some(&[][..]));
        let gated = run(&words, &[game], REQUIRE_PARENT | WITH_DROPPED);
        // 2六歩は 7六歩より先に出たので落ち、その子の 5八金も落ちる
        assert_eq!(gated[0].detections, [at(0, 0, 3)]);
        assert_eq!(
            gated[0].dropped.as_deref(),
            Some(&[at(1, 0, 1), at(2, 0, 5)][..])
        );
    }

    #[test]
    fn same_ply_is_ordered_by_tier() {
        // 1 手目に両方成り立つ。tier の小さい 1 が先に来る
        let words = catalog(
            2,
            &[
                def_words(0, 0, [0; 3], -1, 1, &[1, 1, 7, 6, PAWN as i32, 0]),
                def_words(1, 0, [0; 3], -1, 0, &[1, 1, 2, 8, ROOK as i32, 0]),
            ],
        );
        let results = run(&words, &[&["7g7f"]], MOVER_ONLY);
        assert_eq!(results[0].detections, [at(1, 0, 1), at(0, 0, 1)]);
    }

    #[test]
    fn history_requirements_use_the_real_history() {
        // 銀が 6八に居たことがある (近似の履歴では 1 手目に今の升で付く)
        let words = catalog(
            1,
            &[def_words(
                0,
                0,
                [0; 3],
                -1,
                0,
                &[1, 10, 6, 8, SILVER as i32],
            )],
        );
        let results = run(&words, &[&["7i6h", "3c3d"]], 0);
        assert_eq!(results[0].detections, [at(0, 0, 1)]);
        // 動かしてからも本物の履歴で残る
        let words = catalog(
            1,
            &[def_words(
                0,
                8,
                [3, 0, 0],
                -1,
                0,
                &[1, 10, 6, 8, SILVER as i32],
            )],
        );
        let results = run(&words, &[&["7i6h", "3c3d", "6h7i"]], 0);
        assert_eq!(results[0].detections, [at(0, 0, 3)]);
    }

    #[test]
    fn rejects_broken_input() {
        let words = catalog(1, &[def_words(0, 0, [0; 3], -1, 0, &[0])]);
        let mut scanner = Scanner::new(decode(&words).unwrap());
        let mut out = Vec::new();
        assert_eq!(scanner.scan(&[0; 4], &[1], 0, &mut out), Err(BAD_GAMES));
        assert_eq!(
            scanner.scan(&[], &[u32::MAX, u32::MAX], 0, &mut out),
            Err(BAD_GAMES)
        );
        assert_eq!(scanner.scan(&[], &[0], 64, &mut out), Err(BAD_OPTIONS));
        assert!(out.is_empty());
        // 要件の無い定義は 1 手目で両陣営に付く
        scanner.scan(&usis(&["7g7f"]), &[1], 0, &mut out).unwrap();
        assert_eq!(out, [1, 2, 0, 0, 1, 0, 1, 1]);
    }
}
