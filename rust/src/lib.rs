//! 棋譜の走査 (src/scan.ts の recordDefinitions / recordDefinitionsWithDropped) を
//! WASM で回すための実装。
//!
//! 結果は TS 版と**1 件の違いも無く**一致させる。盤と合法手の判定は tsshogi の挙動を
//! そのまま写す (玉を打つ `K*` が通ることや、打ち歩詰めの判定の癖も含めて)。
//! 定義の解析は TS 側に残し、ここへは解析済みの定義を整数列に直して渡す。
//!
//! # 座標と駒の符号
//!
//! - 升: `x = 9 - file`, `y = rank - 1`, 添字 `y * 9 + x` (0 が 9一、80 が 1九)
//! - 駒種: tsshogi の並びのまま 0 から 13 の 14 種。歩 香 桂 銀 金 角 飛 玉 と金 成香 成桂 成銀 馬 龍
//! - 手番: 先手 0、後手 1
//! - 升の中身: 空は 0、駒は `(color << 4) | (type + 1)`
//!
//! # 定義の符号 (i32 の列)
//!
//! 先頭に `[FORMAT_VERSION, 定義の数, 名前の数]`。名前の数は定義の数以下でなければならない。
//! 続けて定義を並び順のまま 1 件ずつ。
//!
//! 1. `nameId` — 名前ごとの番号 (0 以上、名前の数未満)。同じ名前は同じ番号 (一度きりの判定の鍵)
//! 2. `flags` — bit0 category, bit1 evaluateAtGameEnd, bit2 noDrop,
//!    bit3 plyEq あり, bit4 plyMin あり, bit5 plyMax あり
//! 3. `plyEq`, `plyMin`, `plyMax` — 0 以上。flags に無いものは 0 でなければならない
//! 4. `bishopExchange` — 0 無し, 1 self, 2 opponent, 3 any, 4 never
//! 5. `gateParentNameId` — hierarchy.ts の gateParent が返す定義の nameId。無ければ -1
//! 6. `tier` — order.ts の比較器で並べたときの同順位の組の番号。小さいほど前
//! 7. 最終手 (`finish:`) の数、続けて 1 件ごとに 9 語:
//!    `toFile, toRank, fromFile, fromRank` (from が無ければ 0, 0),
//!    `drop` (0/1), `promote` (0/1),
//!    `captureKind` (0 指定無し, 1 any, 2 none, 3 pieces), `negated` (0/1),
//!    `pieceMask` (駒種 t を bit t に立てたもの)。
//!    captureKind が 0 から 2 のとき、negated と pieceMask は 0 でなければならない
//! 8. 要件の数、続けて 1 件ごとに種別の番号と中身:
//!
//! | 番号 | 種別           | 続く語                                   |
//! |------|----------------|------------------------------------------|
//! | 1    | piece          | file, rank, type, color                  |
//! | 2    | anyOf          | file, rank, mask                         |
//! | 3    | empty          | file, rank                               |
//! | 4    | notOf          | file, rank, mask, color                  |
//! | 5    | anyPiece       | file, rank                               |
//! | 6    | pieceInSquares | color, mask, 升の数 n, (file, rank) を n 組 |
//! | 7    | anywhere       | type                                     |
//! | 8    | hand           | type, minCount                           |
//! | 9    | unmoved        | file, rank                               |
//! | 10   | visited        | file, rank, type                         |
//! | 11   | igyoku         | (無し)                                   |
//!
//! file/rank は定義視点 (先手視点)。color は定義視点の絶対色で、0 が自陣、1 が相手陣。
//!
//! 版が違う、値が範囲の外にある (升は 1 から 9、駒種は 0 から 13、color は 0 か 1、mask は
//! 下の 14 bit だけ、flags は下の 6 bit だけ、hand の minCount は i32 の最小値を除く)、
//! 語が足りないか余る、のどれかに当たれば compile は断る。
//!
//! 同じ名前の定義が複数あっても nameId は 1 つ。親を名前から定義に引くときに後の定義が
//! 勝つ扱い (hierarchy.ts の索引) は、符号を作る側が gateParents で済ませてから
//! gateParentNameId に入れる。走査器は検出した定義自身の gateParentNameId を見て、
//! 親の成立を nameId と陣営で引く。1 局で nameId と陣営が同じ検出は 1 件きりなので、
//! TS が名前と陣営で引くのと同じ結果になる。
//!
//! # 棋譜の符号
//!
//! 指し手 1 つを 5 バイトで表す。USI 文字列の 0..5 文字目の文字コードで、
//! 足りない所は 0、128 以上の文字は 0x7f。6 文字目以降は tsshogi も読まないので捨てる。
//! 局ごとの手数 (USI 文字列の数) は別の u32 の列で渡す。平手から始まる棋譜だけを扱う。
//!
//! # 呼び出し (FFI)
//!
//! - `alloc(len) -> ptr`, `dealloc(ptr, len)` — 線形メモリの確保と解放 (バイト単位)。
//!   alloc は 8 バイト境界の番地を返し、確保できなければ 0。`alloc(0)` は 0 でない番地を
//!   返すが読み書きはできない。dealloc には確保したときと同じ len を渡し、len が 0 なら何もしない
//! - `compile(ptr, words) -> handle` — 定義の符号 (i32 が words 個) を読む。
//!   壊れていれば 0、成功すれば 1 以上。release した番号は後の compile が使い回す
//! - `release(handle)` — 知らない handle は無視する
//! - `scan(handle, moves_ptr, moves_len, lens_ptr, games, options) -> status` —
//!   棋譜をまとめて走査し、結果を内部の出力域に書く。moves_len は棋譜の符号のバイト数、
//!   games は lens の u32 の数。長さが 0 の列は null でもよい。status は 0 が成功、
//!   1 知らない handle、2 moves_len が手数の和の 5 倍でないか、長さのある列が null、
//!   3 知らない options の bit。この順に見て、失敗したときの出力域は空
//! - `out_ptr() -> ptr`, `out_len() -> words` — 出力域 (i32 の列)。次の scan まで読める
//!
//! compile と scan は渡された領域を呼び出しの間だけ読み、手元に残さない。
//! 戻ったら呼ぶ側が dealloc する。i32 と u32 の列は 4 バイト境界に置かなくてもよい
//! (語はバイトから組み立てる)。alloc の返した番地から置けば 4 バイト境界にもなる。
//!
//! `options` の bit:
//! 1 moverOnly, 2 requireParent, 4 suppressGameEndIfDetected,
//! 8 落ちた検出も返す (recordDefinitionsWithDropped),
//! 16 最後の局面も返す (照合用), 32 差分を使わず毎手全部照らす (照合用)
//!
//! 出力は局ごとに次を並べる:
//!
//! 1. 合法な手の数 (buildMoves が返す長さ。不正な手に当たったらそこまで)
//! 2. bit 16 のときだけ、最後の局面: 81 升の中身, 先手の持駒 7 種, 後手の持駒 7 種, 手番
//! 3. 検出の数、続けて `(定義の添字, 陣営, 手数)` の組
//! 4. bit 8 のときだけ、落ちた検出の数、続けて同じ形の組

pub mod board;
pub mod defs;
mod ffi;
#[cfg(test)]
mod fuzz;
pub mod history;
pub mod plan;
pub mod scan;
pub mod sift;

/// 定義の符号の先頭に置く版 (src/wasm/encode.ts の FORMAT_VERSION)
pub const FORMAT_VERSION: i32 = 1;
