//! 走査の後始末。src/hierarchy.ts の dropUnestablishedChildren (親ゲート) と、
//! src/order.ts の orderDetectionsWithinPly (同じ手数の中の並べ替え) を写したもの。

use crate::defs::Def;

/// 検出 1 件。`def` は定義の添字
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Detection {
    pub def: u32,
    pub side: u8,
    pub ply: u32,
}

/// 検出の鍵 (`nameId * 2 + 陣営`)
pub fn key(defs: &[Def], d: &Detection) -> usize {
    defs[d.def as usize].name as usize * 2 + d.side as usize
}

const NONE: u32 = u32::MAX;
const UNKNOWN: u8 = 0;
const FAILED: u8 = 1;
const HELD: u8 = 2;

/// 親ゲートの作業域。鍵ごとの表は定義を読んだときに一度だけ確保し、
/// 1 局ごとに触った鍵だけを戻す
#[derive(Clone, Debug, Default)]
pub struct Gate {
    /// 鍵 → その鍵の検出の添字
    by_key: Vec<u32>,
    /// 鍵 → 判定 (UNKNOWN / FAILED / HELD)
    verdict: Vec<u8>,
    /// 鍵 → いま遡っている途中か
    visiting: Vec<bool>,
    path: Vec<usize>,
    touched: Vec<usize>,
}

impl Gate {
    pub fn new(names: u32) -> Gate {
        let keys = names as usize * 2;
        Gate {
            by_key: vec![NONE; keys],
            verdict: vec![UNKNOWN; keys],
            visiting: vec![false; keys],
            path: Vec::new(),
            touched: Vec::new(),
        }
    }

    /// 親が成立していない子を落とし、残すものを `kept` に、落とすものを `dropped` に
    /// 走査の順のまま積む
    pub fn sift(
        &mut self,
        defs: &[Def],
        scanned: &[Detection],
        kept: &mut Vec<Detection>,
        dropped: &mut Vec<Detection>,
    ) {
        for (i, d) in scanned.iter().enumerate() {
            let k = key(defs, d);
            self.by_key[k] = i as u32;
            self.touched.push(k);
        }
        for d in scanned {
            if self.established(defs, scanned, d) {
                kept.push(*d);
            } else {
                dropped.push(*d);
            }
        }
        for &k in &self.touched {
            self.by_key[k] = NONE;
            self.verdict[k] = UNKNOWN;
        }
        self.touched.clear();
    }

    /// isEstablished を繰り返しで回したもの。親へ進むのは親の検出があって手数も
    /// 前後していないときだけなので、遡った道の上の鍵はすべて行き止まりと同じ判定になる
    fn established(&mut self, defs: &[Def], scanned: &[Detection], start: &Detection) -> bool {
        let mut cur = *start;
        let held = loop {
            let k = key(defs, &cur);
            match self.verdict[k] {
                FAILED => break false,
                HELD => break true,
                _ => {}
            }
            // 循環はそこで打ち切って成立とみなす
            if self.visiting[k] {
                break true;
            }
            self.visiting[k] = true;
            self.path.push(k);
            let Some(parent) = defs[cur.def as usize].gate_parent else {
                break true;
            };
            let found = self.by_key[parent as usize * 2 + cur.side as usize];
            if found == NONE {
                break false;
            }
            let parent = scanned[found as usize];
            if parent.ply > cur.ply {
                break false;
            }
            cur = parent;
        };
        for &k in &self.path {
            self.visiting[k] = false;
            self.verdict[k] = if held { HELD } else { FAILED };
        }
        self.path.clear();
        held
    }
}

/// 同じ手数が続く固まりの中だけを、定義の組 (tier) で安定に並べ替える
pub fn order_within_ply(defs: &[Def], detections: &mut [Detection]) {
    let mut start = 0;
    while start < detections.len() {
        let ply = detections[start].ply;
        let end = start
            + detections[start..]
                .iter()
                .take_while(|d| d.ply == ply)
                .count();
        detections[start..end].sort_by_key(|d| defs[d.def as usize].tier);
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: u32, gate_parent: Option<u32>, tier: u32) -> Def {
        Def {
            name,
            category: false,
            game_end: false,
            no_drop: false,
            ply_eq: None,
            ply_min: None,
            ply_max: None,
            bishop: None,
            gate_parent,
            tier,
            finish: Vec::new(),
            reqs: Vec::new(),
        }
    }

    fn at(def: u32, side: u8, ply: u32) -> Detection {
        Detection { def, side, ply }
    }

    fn run(defs: &[Def], names: u32, scanned: &[Detection]) -> (Vec<Detection>, Vec<Detection>) {
        let mut gate = Gate::new(names);
        let (mut kept, mut dropped) = (Vec::new(), Vec::new());
        gate.sift(defs, scanned, &mut kept, &mut dropped);
        // 作業域は元に戻っている
        assert!(gate.by_key.iter().all(|&i| i == NONE));
        assert!(gate.verdict.iter().all(|&v| v == UNKNOWN));
        assert!(!gate.visiting.iter().any(|&v| v));
        (kept, dropped)
    }

    #[test]
    fn children_need_an_earlier_parent() {
        // 0 が根、1 の親は 0、2 の親は 1
        let defs = [def(0, None, 0), def(1, Some(0), 0), def(2, Some(1), 0)];
        let scanned = [
            at(2, 0, 3),
            at(0, 0, 5),
            at(1, 0, 5),
            at(2, 1, 4),
            at(1, 1, 2),
        ];
        let (kept, dropped) = run(&defs, 3, &scanned);
        // 先手の 2 は親 1 (5 手目) より前に出たので落ち、後手は根が無いので 1 も 2 も落ちる
        assert_eq!(kept, [at(0, 0, 5), at(1, 0, 5)]);
        assert_eq!(dropped, [at(2, 0, 3), at(2, 1, 4), at(1, 1, 2)]);
    }

    #[test]
    fn a_failing_child_does_not_fail_its_parent() {
        let defs = [def(0, None, 0), def(1, Some(0), 0), def(2, Some(1), 0)];
        let scanned = [at(2, 0, 1), at(1, 0, 4), at(0, 0, 3)];
        let (kept, dropped) = run(&defs, 3, &scanned);
        assert_eq!(kept, [at(1, 0, 4), at(0, 0, 3)]);
        assert_eq!(dropped, [at(2, 0, 1)]);
    }

    #[test]
    fn cycles_count_as_established() {
        // 0 と 1 が互いを親に持ち、2 の親は 1
        let defs = [def(0, Some(1), 0), def(1, Some(0), 0), def(2, Some(1), 0)];
        let scanned = [at(0, 0, 3), at(1, 0, 3), at(2, 0, 4), at(2, 1, 1)];
        let (kept, dropped) = run(&defs, 3, &scanned);
        assert_eq!(kept, [at(0, 0, 3), at(1, 0, 3), at(2, 0, 4)]);
        assert_eq!(dropped, [at(2, 1, 1)]);
        // 同じ名前を共有する定義も鍵で引く
        let defs = [def(0, None, 0), def(1, Some(0), 0), def(0, None, 0)];
        let (kept, _) = run(&defs, 2, &[at(2, 1, 2), at(1, 1, 2)]);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn ordering_stays_within_each_ply() {
        let defs = [def(0, None, 2), def(1, None, 0), def(2, None, 1)];
        let mut detections = [
            at(0, 0, 3),
            at(1, 1, 3),
            at(2, 0, 3),
            at(0, 1, 5),
            at(1, 0, 4),
            at(2, 1, 3),
        ];
        order_within_ply(&defs, &mut detections);
        assert_eq!(
            detections,
            [
                at(1, 1, 3),
                at(2, 0, 3),
                at(0, 0, 3),
                at(0, 1, 5),
                at(1, 0, 4),
                at(2, 1, 3)
            ]
        );
    }
}
