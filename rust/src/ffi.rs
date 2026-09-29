//! WASM に書き出す関数。取り決めは lib.rs の「呼び出し (FFI)」を見ること。
//!
//! 読み込んだ定義と出力域はスレッドごとの表に置く (WASM では 1 本しか無い)。
//! 受け取る指し示しは揃っているとは限らないので、語はバイトから組み立てる。

use std::alloc::{Layout, alloc as allocate, dealloc as deallocate};
use std::cell::RefCell;
use std::ptr::NonNull;

use crate::defs::{Catalog, decode};
use crate::scan::{BAD_HANDLE, Scanner};

#[derive(Default)]
struct State {
    /// handle - 1 → 読み込んだ定義。release した所は None
    compiled: Vec<Option<Box<Scanner>>>,
    out: Vec<i32>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

const ALIGN: usize = 8;

/// `ptr` から `len` バイト。長さが 0 なら null でもよい
///
/// # Safety
///
/// `len` が 0 でなければ、`ptr` から `len` バイトが読めること
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if len == 0 {
        Some(&[])
    } else if ptr.is_null() {
        None
    } else {
        // SAFETY: 呼び出し側が `len` バイト読めることを保証する
        Some(unsafe { std::slice::from_raw_parts(ptr, len) })
    }
}

/// 線形メモリに `len` バイトを確保する。失敗すれば 0
///
/// # Safety
///
/// 返した所は `dealloc` に同じ `len` で返すこと
#[unsafe(no_mangle)]
pub unsafe extern "C" fn alloc(len: usize) -> *mut u8 {
    match Layout::from_size_align(len, ALIGN) {
        Ok(_) if len == 0 => NonNull::<u64>::dangling().as_ptr().cast(),
        // SAFETY: 大きさは 0 でない
        Ok(layout) => unsafe { allocate(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// `alloc` で確保した所を返す
///
/// # Safety
///
/// `ptr` と `len` は `alloc` の返した所とそのときの長さであること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(len, ALIGN) {
        // SAFETY: 同じ大きさと揃えで確保した所
        unsafe { deallocate(ptr, layout) };
    }
}

/// 定義の符号 (i32 が `words` 個) を読む
///
/// # Safety
///
/// `ptr` から `words * 4` バイトが読めること
unsafe fn catalog_of(ptr: *const u8, words: usize) -> Option<Catalog> {
    let len = words.checked_mul(4)?;
    // SAFETY: 呼び出し側が保証する
    let raw = unsafe { bytes(ptr, len) }?;
    let words: Vec<i32> = raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&w| i32::from_le_bytes(w))
        .collect();
    decode(&words)
}

/// 走査器を表に置き、handle (1 以上) を返す。release した所は使い回す
fn store(scanner: Scanner) -> u32 {
    let scanner = Box::new(scanner);
    STATE.with_borrow_mut(|state| {
        let slot = match state.compiled.iter().position(Option::is_none) {
            Some(free) => free,
            None => {
                state.compiled.push(None);
                state.compiled.len() - 1
            }
        };
        state.compiled[slot] = Some(scanner);
        slot as u32 + 1
    })
}

/// 定義の符号 (i32 が `words` 個) を読む。壊れていれば 0、読めれば 1 以上の handle
///
/// # Safety
///
/// `ptr` から `words * 4` バイトが読めること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile(ptr: *const u8, words: usize) -> u32 {
    // SAFETY: 呼び出し側が保証する
    match unsafe { catalog_of(ptr, words) } {
        Some(catalog) => store(Scanner::new(catalog)),
        None => 0,
    }
}

/// 定義の符号を 2 組読み、盤と履歴を共有する 1 つの走査器にする。壊れていれば 0、
/// 読めれば 1 以上の handle。`scan_pair` で回す (`scan` は使えない)
///
/// # Safety
///
/// `a_ptr` から `a_words * 4` バイト、`b_ptr` から `b_words * 4` バイトが読めること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile_pair(
    a_ptr: *const u8,
    a_words: usize,
    b_ptr: *const u8,
    b_words: usize,
) -> u32 {
    // SAFETY: 呼び出し側が保証する
    let (Some(a), Some(b)) = (unsafe { catalog_of(a_ptr, a_words) }, unsafe {
        catalog_of(b_ptr, b_words)
    }) else {
        return 0;
    };
    store(Scanner::group(vec![a, b]))
}

/// 読み込んだ定義を捨てる。知らない handle は無視する
///
/// # Safety
///
/// 引数は整数だけなので、いつ呼んでもよい
#[unsafe(no_mangle)]
pub unsafe extern "C" fn release(handle: u32) {
    STATE.with_borrow_mut(|state| {
        if let Some(slot) = (handle as usize)
            .checked_sub(1)
            .and_then(|i| state.compiled.get_mut(i))
        {
            *slot = None;
        }
    });
}

/// 棋譜をまとめて走査し、出力域に書く。`groups` が 0 でなければ、走査器の集まりの数と
/// 合っていないと BAD_HANDLE。`options` は集まりごとに渡す
///
/// # Safety
///
/// `moves_ptr` から `moves_len` バイト、`lens_ptr` から `games * 4` バイトが読めること
unsafe fn run_scan(
    handle: u32,
    groups: usize,
    moves_ptr: *const u8,
    moves_len: usize,
    lens_ptr: *const u8,
    games: usize,
    options: &[u32],
) -> u32 {
    STATE.with_borrow_mut(|state| {
        let State { compiled, out } = state;
        out.clear();
        let Some(scanner) = (handle as usize)
            .checked_sub(1)
            .and_then(|i| compiled.get_mut(i))
            .and_then(Option::as_mut)
        else {
            return BAD_HANDLE;
        };
        if scanner.groups() != groups {
            return BAD_HANDLE;
        }
        // SAFETY: 呼び出し側が保証する
        let (Some(moves), Some(lens)) = (
            unsafe { bytes(moves_ptr, moves_len) },
            games
                .checked_mul(4)
                .and_then(|len| unsafe { bytes(lens_ptr, len) }),
        ) else {
            return crate::scan::BAD_GAMES;
        };
        let lens: Vec<u32> = lens
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&w| u32::from_le_bytes(w))
            .collect();
        match scanner.scan_group(moves, &lens, options, out) {
            Ok(()) => 0,
            Err(status) => {
                out.clear();
                status
            }
        }
    })
}

/// 棋譜をまとめて走査し、出力域に書く。0 が成功。失敗すれば出力域は空
///
/// # Safety
///
/// `moves_ptr` から `moves_len` バイト、`lens_ptr` から `games * 4` バイトが読めること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan(
    handle: u32,
    moves_ptr: *const u8,
    moves_len: usize,
    lens_ptr: *const u8,
    games: usize,
    options: u32,
) -> u32 {
    // SAFETY: 呼び出し側が保証する
    unsafe { run_scan(handle, 1, moves_ptr, moves_len, lens_ptr, games, &[options]) }
}

/// `compile_pair` で読んだ走査器で、棋譜をまとめて走査する。出力は局ごとに
/// 合法な手の数、1 組めの検出、2 組めの検出の順 (最後の局面は 1 組めの options で決まる)。
/// 0 が成功。失敗すれば出力域は空
///
/// # Safety
///
/// `moves_ptr` から `moves_len` バイト、`lens_ptr` から `games * 4` バイトが読めること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_pair(
    handle: u32,
    moves_ptr: *const u8,
    moves_len: usize,
    lens_ptr: *const u8,
    games: usize,
    a_options: u32,
    b_options: u32,
) -> u32 {
    // SAFETY: 呼び出し側が保証する
    unsafe {
        run_scan(
            handle,
            2,
            moves_ptr,
            moves_len,
            lens_ptr,
            games,
            &[a_options, b_options],
        )
    }
}

/// 出力域の先頭
///
/// # Safety
///
/// 次に `scan` を呼ぶまでのあいだだけ読めること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn out_ptr() -> *const i32 {
    STATE.with_borrow(|state| state.out.as_ptr())
}

/// 出力域の長さ (i32 の数)
///
/// # Safety
///
/// 引数は無いので、いつ呼んでもよい
#[unsafe(no_mangle)]
pub unsafe extern "C" fn out_len() -> usize {
    STATE.with_borrow(|state| state.out.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FORMAT_VERSION;
    use crate::board::PAWN;
    use crate::scan::{BAD_GAMES, BAD_OPTIONS};

    fn to_bytes(words: &[i32]) -> Vec<u8> {
        words.iter().flat_map(|w| w.to_le_bytes()).collect()
    }

    fn output() -> Vec<i32> {
        // SAFETY: 直前の scan の出力域
        unsafe { std::slice::from_raw_parts(out_ptr(), out_len()).to_vec() }
    }

    #[test]
    fn round_trip() {
        // 7六歩の定義 1 件。揃っていない所に置く
        let words = [
            FORMAT_VERSION,
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
            1,
            1,
            7,
            6,
            PAWN as i32,
            0,
        ];
        let mut raw = vec![0u8];
        raw.extend(to_bytes(&words));
        // SAFETY: 読める所を渡す
        unsafe {
            assert_eq!(compile(raw.as_ptr(), 1), 0);
            assert_eq!(compile(std::ptr::null(), words.len()), 0);
            let handle = compile(raw[1..].as_ptr(), words.len());
            assert!(handle >= 1);

            let moves = *b"7g7f\x003c3d\x00";
            let mut lens = vec![0u8];
            lens.extend(to_bytes(&[2]));
            assert_eq!(
                scan(
                    handle,
                    moves.as_ptr(),
                    moves.len(),
                    lens[1..].as_ptr(),
                    1,
                    0
                ),
                0
            );
            assert_eq!(output(), [2, 2, 0, 0, 1, 0, 1, 2]);
            // 局が 0 なら null でよい
            assert_eq!(scan(handle, std::ptr::null(), 0, std::ptr::null(), 0, 0), 0);
            assert_eq!(out_len(), 0);

            assert_eq!(
                scan(
                    handle,
                    moves.as_ptr(),
                    moves.len() - 1,
                    lens[1..].as_ptr(),
                    1,
                    0
                ),
                BAD_GAMES
            );
            assert_eq!(out_len(), 0);
            assert_eq!(
                scan(handle, std::ptr::null(), 10, lens[1..].as_ptr(), 1, 0),
                BAD_GAMES
            );
            assert_eq!(
                scan(
                    handle,
                    moves.as_ptr(),
                    moves.len(),
                    lens[1..].as_ptr(),
                    1,
                    64
                ),
                BAD_OPTIONS
            );
            assert_eq!(
                scan(
                    handle + 1,
                    moves.as_ptr(),
                    moves.len(),
                    lens[1..].as_ptr(),
                    1,
                    0
                ),
                BAD_HANDLE
            );
            assert_eq!(
                scan(0, moves.as_ptr(), moves.len(), lens[1..].as_ptr(), 1, 0),
                BAD_HANDLE
            );

            // 捨てた handle は使えず、空いた所は次の compile が使う
            release(handle);
            release(handle);
            release(0);
            assert_eq!(
                scan(
                    handle,
                    moves.as_ptr(),
                    moves.len(),
                    lens[1..].as_ptr(),
                    1,
                    0
                ),
                BAD_HANDLE
            );
            assert_eq!(compile(raw[1..].as_ptr(), words.len()), handle);
            release(handle);
        }
    }

    #[test]
    fn a_pair_scans_both_groups_in_one_pass() {
        // 7六歩 (1 組め) と 3四歩 (2 組め) の定義を 1 件ずつ
        let pawn = |file: i32, rank: i32| {
            to_bytes(&[
                FORMAT_VERSION,
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
                1,
                1,
                file,
                rank,
                PAWN as i32,
                0,
            ])
        };
        let (a, b) = (pawn(7, 6), pawn(3, 4));
        let moves = *b"7g7f\x003c3d\x00";
        let lens = to_bytes(&[2]);
        // SAFETY: 読める所を渡す
        unsafe {
            assert_eq!(compile_pair(a.as_ptr(), 18, std::ptr::null(), 18), 0);
            let handle = compile_pair(a.as_ptr(), 18, b.as_ptr(), 18);
            assert!(handle >= 1);
            // 局面の代わりに、両方の答えが局ごとに並ぶ (合法な手 2、1 組めの 1 件、2 組めの 1 件)
            assert_eq!(
                scan_pair(handle, moves.as_ptr(), moves.len(), lens.as_ptr(), 1, 0, 0),
                0
            );
            let both = output();
            // 別々に回した答えを、合法な手の数のあとへつないだものと同じ
            let (one, two) = (compile(a.as_ptr(), 18), compile(b.as_ptr(), 18));
            assert_eq!(
                scan(one, moves.as_ptr(), moves.len(), lens.as_ptr(), 1, 0),
                0
            );
            let first = output();
            assert_eq!(
                scan(two, moves.as_ptr(), moves.len(), lens.as_ptr(), 1, 0),
                0
            );
            let second = output();
            assert_eq!(both, [&first[..], &second[1..]].concat());
            // 集まりの数の違う走査は取り違えない
            assert_eq!(
                scan(handle, moves.as_ptr(), moves.len(), lens.as_ptr(), 1, 0),
                BAD_HANDLE
            );
            assert_eq!(
                scan_pair(one, moves.as_ptr(), moves.len(), lens.as_ptr(), 1, 0, 0),
                BAD_HANDLE
            );
            assert_eq!(
                scan_pair(handle, moves.as_ptr(), moves.len(), lens.as_ptr(), 1, 0, 64),
                BAD_OPTIONS
            );
            assert_eq!(out_len(), 0);
            for handle in [handle, one, two] {
                release(handle);
            }
        }
    }

    #[test]
    fn allocation() {
        // SAFETY: 確保した所だけを書いて返す
        unsafe {
            let ptr = alloc(13);
            assert!(!ptr.is_null());
            ptr.write_bytes(7, 13);
            dealloc(ptr, 13);
            let empty = alloc(0);
            assert!(!empty.is_null());
            dealloc(empty, 0);
            assert!(alloc(usize::MAX).is_null());
        }
    }
}
