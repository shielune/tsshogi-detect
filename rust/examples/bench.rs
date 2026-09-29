//! 実際の棋譜で走査器 (Scanner) の速さを測る。
//!
//! ```text
//! zcat 棋譜.usi.gz... | cargo run --release --example bench -- 囲い.i32 戦法.i32 \
//!     [--threads 6] [--every 125] [--sample 20000] [--dump 標本.i32]
//! ```
//!
//! 棋譜は 1 行 1 局の USI (scripts/convert-csa-kifu.ts が書くもの)。定義は
//! scripts/bench-encode-definitions.ts が書く i32 (little endian) の列。囲いは options 7、
//! 戦法は 3 で回す (scripts/bench-compare.ts と同じ指定)。
//!
//! 時間は読み込みと符号化を含まない。1 本のときは scan の呼び出しだけを数え、
//! 複数本のときはスレッドを立ててから全部戻るまでを数える。
//!
//! 照合値は局ごとに「検出の数、続けて (定義の添字, 陣営, 手数)」の語を FNV-1a で畳んだもの。
//! scripts/bench-wasm-kifu.ts が WASM の結果から同じ値を出す。
//! `--dump` には `--every` 局に 1 局 (最大 `--sample` 局) の出力を、囲い・戦法の順に
//! 局ごとの出力の形 (合法な手の数、検出の数、組) のまま書く。

use std::io::Read;
use std::time::{Duration, Instant};

use tsshogi_detect_scan::defs::decode;
use tsshogi_detect_scan::scan::{
    MOVE_BYTES, MOVER_ONLY, REQUIRE_PARENT, SUPPRESS_GAME_END, Scanner,
};

/// 1 回の scan に渡す局数 (src/wasm/scanner.ts の CHUNK_GAMES と同じ)
const CHUNK: usize = 2000;
const WARMUP: usize = 500;
const OPTIONS: [u32; 2] = [
    MOVER_ONLY | REQUIRE_PARENT | SUPPRESS_GAME_END,
    MOVER_ONLY | REQUIRE_PARENT,
];
const FNV_OFFSET: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

struct Args {
    definitions: [String; 2],
    threads: usize,
    every: usize,
    sample: usize,
    dump: Option<String>,
}

fn parse_args() -> Args {
    let mut positionals = Vec::new();
    let mut threads = 6;
    let mut every = 125;
    let mut sample = 20000;
    let mut dump = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().unwrap_or_else(|| panic!("{arg} に値が無い"));
        match arg.as_str() {
            "--threads" => threads = value().parse().expect("--threads"),
            "--every" => every = value().parse().expect("--every"),
            "--sample" => sample = value().parse().expect("--sample"),
            "--dump" => dump = Some(value()),
            _ => positionals.push(arg),
        }
    }
    let [castles, strategies]: [String; 2] = positionals.try_into().expect(
        "usage: bench 囲い.i32 戦法.i32 [--threads N] [--every N] [--sample N] [--dump path]",
    );
    Args {
        definitions: [castles, strategies],
        threads,
        every,
        sample,
        dump,
    }
}

fn load_scanner(path: &str) -> Scanner {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let words: Vec<i32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&w| i32::from_le_bytes(w))
        .collect();
    Scanner::new(decode(&words).unwrap_or_else(|| panic!("{path}: 定義の符号が読めない")))
}

/// 棋譜の列。`starts[g]` は g 局目の最初の指し手の番号 (末尾に全体の手数)
struct Games {
    moves: Vec<u8>,
    lens: Vec<u32>,
    starts: Vec<usize>,
}

impl Games {
    fn count(&self) -> usize {
        self.lens.len()
    }

    fn slice(&self, from: usize, to: usize) -> (&[u8], &[u32]) {
        (
            &self.moves[self.starts[from] * MOVE_BYTES..self.starts[to] * MOVE_BYTES],
            &self.lens[from..to],
        )
    }
}

/// 標準入力の USI を棋譜の符号 (lib.rs の「棋譜の符号」) にする
fn read_games() -> Games {
    let mut text = Vec::new();
    std::io::stdin()
        .lock()
        .read_to_end(&mut text)
        .expect("標準入力が読めない");
    if text.last() == Some(&b'\n') {
        text.pop();
    }
    let mut moves = Vec::with_capacity(text.len() + text.len() / 4);
    let mut lens = Vec::new();
    let mut starts = vec![0];
    let mut total = 0;
    for line in text.split(|&b| b == b'\n') {
        let mut n = 0u32;
        if !line.is_empty() {
            for usi in line.split(|&b| b == b' ') {
                let mut chunk = [0u8; MOVE_BYTES];
                for (slot, &b) in chunk.iter_mut().zip(usi) {
                    *slot = if b >= 0x80 { 0x7f } else { b };
                }
                moves.extend_from_slice(&chunk);
                n += 1;
            }
        }
        lens.push(n);
        total += n as usize;
        starts.push(total);
    }
    Games {
        moves,
        lens,
        starts,
    }
}

/// 1 局ぶんの出力 (合法な手の数、検出の数、組) の語数
fn game_words(out: &[i32], at: usize) -> usize {
    2 + 3 * out[at + 1] as usize
}

#[derive(Default, Clone, Copy)]
struct Tally {
    legal: u64,
    detections: [u64; 2],
}

/// 1 本で全局を回す。scan の時間を group ごとに返す
fn run_single(
    scanners: &mut [Scanner; 2],
    games: &Games,
    args: &Args,
    dump: &mut Vec<i32>,
) -> ([Duration; 2], Tally, [u32; 2]) {
    let mut elapsed = [Duration::ZERO; 2];
    let mut tally = Tally::default();
    let mut hashes = [FNV_OFFSET; 2];
    let mut sampled = 0;
    let mut outs = [Vec::new(), Vec::new()];
    for from in (0..games.count()).step_by(CHUNK) {
        let to = (from + CHUNK).min(games.count());
        let (moves, lens) = games.slice(from, to);
        for group in 0..2 {
            outs[group].clear();
            let start = Instant::now();
            scanners[group]
                .scan(moves, lens, OPTIONS[group], &mut outs[group])
                .expect("scan が断った");
            elapsed[group] += start.elapsed();
        }
        let mut at = [0usize; 2];
        for game in from..to {
            let take = game % args.every == 0 && sampled < args.sample;
            for group in 0..2 {
                let out = &outs[group];
                let words = game_words(out, at[group]);
                let body = &out[at[group] + 1..at[group] + words];
                if group == 0 {
                    tally.legal += out[at[group]] as u64;
                }
                tally.detections[group] += body[0] as u64;
                for &w in body {
                    hashes[group] = (hashes[group] ^ w as u32).wrapping_mul(FNV_PRIME);
                }
                if take {
                    dump.extend_from_slice(&out[at[group]..at[group] + words]);
                }
                at[group] += words;
            }
            sampled += usize::from(take);
        }
        assert_eq!(at, [outs[0].len(), outs[1].len()], "出力の語数が合わない");
    }
    (elapsed, tally, hashes)
}

/// `threads` 本に局を分けて回す。手数がほぼ等しくなるよう続きの範囲で分ける
fn run_parallel(scanners: &[Scanner; 2], games: &Games, threads: usize) -> (Duration, Tally) {
    let total = *games.starts.last().unwrap_or(&0);
    let bounds: Vec<usize> = (0..=threads)
        .map(|k| {
            games
                .starts
                .partition_point(|&s| s < total * k / threads)
                .min(games.count())
        })
        .collect();
    let start = Instant::now();
    let tallies: Vec<Tally> = std::thread::scope(|scope| {
        let handles: Vec<_> = bounds
            .windows(2)
            .map(|range| {
                let (lo, hi) = (range[0], range[1]);
                let mut scanners = scanners.clone();
                scope.spawn(move || {
                    let mut tally = Tally::default();
                    let mut out = Vec::new();
                    for from in (lo..hi).step_by(CHUNK) {
                        let to = (from + CHUNK).min(hi);
                        let (moves, lens) = games.slice(from, to);
                        for group in 0..2 {
                            out.clear();
                            scanners[group]
                                .scan(moves, lens, OPTIONS[group], &mut out)
                                .expect("scan が断った");
                            let mut at = 0;
                            while at < out.len() {
                                if group == 0 {
                                    tally.legal += out[at] as u64;
                                }
                                tally.detections[group] += out[at + 1] as u64;
                                at += game_words(&out, at);
                            }
                        }
                    }
                    tally
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("スレッドが落ちた"))
            .collect()
    });
    let elapsed = start.elapsed();
    let sum = tallies.iter().fold(Tally::default(), |a, t| Tally {
        legal: a.legal + t.legal,
        detections: [
            a.detections[0] + t.detections[0],
            a.detections[1] + t.detections[1],
        ],
    });
    (elapsed, sum)
}

fn per_game(d: Duration, games: usize) -> f64 {
    d.as_secs_f64() * 1000.0 / games as f64
}

fn main() {
    let args = parse_args();
    let mut scanners = [
        load_scanner(&args.definitions[0]),
        load_scanner(&args.definitions[1]),
    ];
    let loading = Instant::now();
    let games = read_games();
    let total_moves = *games.starts.last().unwrap_or(&0);
    println!(
        "棋譜: 局 {}, 手 {} (符号 {} MB), 読み込み {:.1} s",
        games.count(),
        total_moves,
        games.moves.len() / 1_000_000,
        loading.elapsed().as_secs_f64(),
    );

    // 温める。数えない
    let warm = WARMUP.min(games.count());
    let (moves, lens) = games.slice(0, warm);
    for group in 0..2 {
        let mut out = Vec::new();
        scanners[group]
            .scan(moves, lens, OPTIONS[group], &mut out)
            .expect("scan が断った");
    }

    let mut dump = Vec::new();
    let (elapsed, tally, hashes) = run_single(&mut scanners, &games, &args, &mut dump);
    let single = elapsed[0] + elapsed[1];
    println!(
        "1 本: {:.4} ms/局 (囲い {:.4}, 戦法 {:.4}), 計 {:.1} s",
        per_game(single, games.count()),
        per_game(elapsed[0], games.count()),
        per_game(elapsed[1], games.count()),
        single.as_secs_f64(),
    );
    println!(
        "  合法な手 {}, 検出 囲い {} 戦法 {}, 照合値 囲い {:08x} 戦法 {:08x}",
        tally.legal, tally.detections[0], tally.detections[1], hashes[0], hashes[1],
    );

    // 囲いと戦法を 1 つの走査器にまとめて (盤と履歴を共有して) 回し、別々の答えと突き合わせる
    let mut pair = Scanner::group(vec![
        scanners[0].catalog().clone(),
        scanners[1].catalog().clone(),
    ]);
    let (mut paired, mut separate_hash) = (Duration::ZERO, [FNV_OFFSET; 2]);
    let mut out = Vec::new();
    for from in (0..games.count()).step_by(CHUNK) {
        let to = (from + CHUNK).min(games.count());
        let (moves, lens) = games.slice(from, to);
        out.clear();
        let start = Instant::now();
        pair.scan_group(moves, lens, &OPTIONS, &mut out)
            .expect("scan_group が断った");
        paired += start.elapsed();
        // 局ごとに 合法な手の数、囲いの検出、戦法の検出
        let mut at = 0;
        for _ in from..to {
            at += 1;
            for hash in &mut separate_hash {
                let words = 1 + 3 * out[at] as usize;
                for &w in &out[at..at + words] {
                    *hash = (*hash ^ w as u32).wrapping_mul(FNV_PRIME);
                }
                at += words;
            }
        }
        assert_eq!(at, out.len());
    }
    println!(
        "まとめて 1 つ: {:.4} ms/局 (別々の {:.2} 倍)  照合値 囲い {:08x} 戦法 {:08x}",
        per_game(paired, games.count()),
        single.as_secs_f64() / paired.as_secs_f64(),
        separate_hash[0],
        separate_hash[1],
    );

    if args.threads > 1 {
        let (wall, parallel) = run_parallel(&scanners, &games, args.threads);
        println!(
            "{} 本: 計 {:.1} s ({:.4} ms/局 相当, 1 本の {:.2} 倍)",
            args.threads,
            wall.as_secs_f64(),
            per_game(wall, games.count()),
            single.as_secs_f64() / wall.as_secs_f64(),
        );
        assert_eq!(parallel.legal, tally.legal, "合法な手の数が 1 本と違う");
        assert_eq!(
            parallel.detections, tally.detections,
            "検出の数が 1 本と違う"
        );
    }

    if let Some(path) = &args.dump {
        let bytes: Vec<u8> = dump.iter().flat_map(|w| w.to_le_bytes()).collect();
        std::fs::write(path, bytes).unwrap_or_else(|e| panic!("{path}: {e}"));
        println!("標本: {} 語を {path} に書いた", dump.len());
    }
}
