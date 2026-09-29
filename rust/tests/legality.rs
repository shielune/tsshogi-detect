//! 盤 (board.rs) の合法手の判定が tsshogi と一致するかの試験。
//!
//! 前半は scripts/gen-legality-fixture.ts が tsshogi で作った fixture との照合。
//! 各局面で合法手の集合 (数と FNV-1a) と、壊れた USI の扱いと、指し進めた盤を比べる。
//! 後半は打ち歩詰めや玉 2 枚などを狙い撃ちにした試験で、見込みを直接書いてある。

use tsshogi_detect_scan::board::*;

const FIXTURE: &str = include_str!("fixtures/legality.txt");

/// 候補を並べる順 (fixture と同じ): 手番の駒の升を添字順、行き先を添字順、不成と成。
/// そのあと打ちを P L N S G B R K の順、行き先を添字順。
fn legal_moves(position: &Position) -> Vec<Move> {
    let captured = |to: u8| match position.cells[to as usize] {
        0 => NO_PIECE,
        c => cell_type(c),
    };
    let mut out = Vec::new();
    for from in 0..81u8 {
        let piece = position.cells[from as usize];
        if piece == 0 || cell_color(piece) != position.turn {
            continue;
        }
        for to in 0..81u8 {
            for promote in [false, true] {
                let m = Move {
                    from,
                    to,
                    piece_type: cell_type(piece),
                    color: position.turn,
                    promote,
                    captured: captured(to),
                };
                if position.is_valid_move(&m) {
                    out.push(m);
                }
            }
        }
    }
    for piece_type in [PAWN, LANCE, KNIGHT, SILVER, GOLD, BISHOP, ROOK, KING] {
        for to in 0..81u8 {
            let m = Move {
                from: NO_SQUARE,
                to,
                piece_type,
                color: position.turn,
                promote: false,
                captured: captured(to),
            };
            if position.is_valid_move(&m) {
                out.push(m);
            }
        }
    }
    // USI を読み直しても同じ手になること
    for m in &out {
        assert_eq!(
            position.move_from_usi(usi(m).as_bytes()),
            Some(*m),
            "{}",
            usi(m)
        );
    }
    out
}

fn usi(m: &Move) -> String {
    let square = |sq: u8| format!("{}{}", file_of(sq), (b'a' + rank_of(sq) - 1) as char);
    let mut out = if m.is_drop() {
        format!("{}*", b"PLNSGBRK"[m.piece_type as usize] as char)
    } else {
        square(m.from)
    };
    out += &square(m.to);
    if m.promote {
        out.push('+');
    }
    out
}

/// 数と FNV-1a 32bit (各 USI の後ろに空白を付けて連ねたもの)
fn summary(moves: &[Move]) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for m in moves {
        for b in usi(m).bytes().chain(*b" ") {
            hash ^= b as u32;
            hash = hash.wrapping_mul(0x01000193);
        }
    }
    format!("{}:{hash:08x}", moves.len())
}

/// n: 手を作れない, v: 合法, i: 不正
fn judge(position: &Position, usi: &[u8]) -> char {
    match position.move_from_usi(usi) {
        None => 'n',
        Some(m) if position.is_valid_move(&m) => 'v',
        Some(_) => 'i',
    }
}

fn probe(position: &Position, probes: &[Vec<u8>]) -> String {
    probes.iter().map(|usi| judge(position, usi)).collect()
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn piece_letter(c: char) -> u8 {
    match c.to_ascii_uppercase() {
        'P' => PAWN,
        'L' => LANCE,
        'N' => KNIGHT,
        'S' => SILVER,
        'G' => GOLD,
        'B' => BISHOP,
        'R' => ROOK,
        'K' => KING,
        _ => panic!("unknown piece {c}"),
    }
}

fn parse_sfen(sfen: &str) -> Position {
    let mut parts = sfen.split(' ');
    let board = parts.next().unwrap();
    let turn = match parts.next().unwrap() {
        "b" => BLACK,
        "w" => WHITE,
        other => panic!("bad turn {other}"),
    };
    let mut cells = [0u8; 81];
    for (y, row) in board.split('/').enumerate() {
        let mut x = 0;
        let mut promote = false;
        for c in row.chars() {
            if let Some(n) = c.to_digit(10) {
                x += n as usize;
            } else if c == '+' {
                promote = true;
            } else {
                let color = if c.is_ascii_uppercase() { BLACK } else { WHITE };
                let piece_type = piece_letter(c);
                let piece_type = if promote {
                    promoted(piece_type)
                } else {
                    piece_type
                };
                cells[y * 9 + x] = cell(color, piece_type);
                promote = false;
                x += 1;
            }
        }
        assert_eq!(x, 9, "{sfen}");
    }
    let mut hands = [[0u8; HAND_TYPES]; 2];
    let hand = parts.next().unwrap();
    if hand != "-" {
        let mut count = 0u8;
        for c in hand.chars() {
            if let Some(d) = c.to_digit(10) {
                count = count * 10 + d as u8;
            } else {
                let color = if c.is_ascii_uppercase() { BLACK } else { WHITE };
                hands[color as usize][piece_letter(c) as usize] += count.max(1);
                count = 0;
            }
        }
    }
    Position::from_parts(cells, hands, turn)
}

/// 玉の控えが盤と食い違っていないか
fn assert_kings(position: &Position) {
    let fresh = Position::from_parts(position.cells, position.hands, position.turn);
    for color in [BLACK, WHITE] {
        assert_eq!(position.king_square(color), fresh.king_square(color));
    }
}

struct Game<'a> {
    name: &'a str,
    moves: Vec<&'a str>,
    legal: Vec<&'a str>,
    probes: Vec<(usize, &'a str)>,
    last: &'a str,
}

fn parse_fixture() -> (Vec<Vec<u8>>, Vec<Game<'static>>, Vec<&'static str>) {
    let mut probes = Vec::new();
    let mut games: Vec<Game> = Vec::new();
    let mut cases = Vec::new();
    for line in FIXTURE.lines() {
        let (head, rest) = line.split_once(' ').unwrap_or((line, ""));
        match head {
            "probes" => probes = rest.split(' ').map(hex_bytes).collect(),
            "game" => games.push(Game {
                name: rest,
                moves: Vec::new(),
                legal: Vec::new(),
                probes: Vec::new(),
                last: "",
            }),
            "moves" => {
                games.last_mut().unwrap().moves =
                    rest.split(' ').filter(|s| !s.is_empty()).collect()
            }
            "legal" => games.last_mut().unwrap().legal = rest.split(' ').collect(),
            "probe" => {
                let (ply, result) = rest.split_once(' ').unwrap();
                games
                    .last_mut()
                    .unwrap()
                    .probes
                    .push((ply.parse().unwrap(), result));
            }
            "final" => games.last_mut().unwrap().last = rest,
            _ if line.starts_with("case|") => cases.push(line),
            _ if line.starts_with('#') => {}
            _ => panic!("unknown fixture line: {line}"),
        }
    }
    (probes, games, cases)
}

fn final_state(position: &Position) -> String {
    let cells: String = position.cells.iter().map(|c| format!("{c:02x}")).collect();
    let hands: Vec<String> = position
        .hands
        .iter()
        .flatten()
        .map(|n| n.to_string())
        .collect();
    format!("{cells} {} {}", hands.join(","), position.turn)
}

#[test]
fn random_games_match_tsshogi() {
    let (probes, games, _) = parse_fixture();
    assert_eq!(games.len(), 36);
    let mut positions = 0;
    let mut king_drops = 0;
    for game in &games {
        assert_eq!(game.legal.len(), game.moves.len() + 1, "game {}", game.name);
        let mut position = Position::hirate();
        for (ply, expected) in game.legal.iter().enumerate() {
            let at = format!("game {} ply {ply}", game.name);
            assert_eq!(summary(&legal_moves(&position)), *expected, "{at}");
            for (_, result) in game.probes.iter().filter(|(p, _)| *p == ply) {
                assert_eq!(probe(&position, &probes), *result, "{at} probes");
            }
            positions += 1;
            let Some(usi) = game.moves.get(ply) else {
                break;
            };
            let m = position.move_from_usi(usi.as_bytes()).unwrap();
            assert!(position.is_valid_move(&m), "{at} {usi}");
            king_drops += usize::from(usi.starts_with("K*"));
            position.do_move(&m);
            assert_kings(&position);
        }
        assert_eq!(
            final_state(&position),
            game.last,
            "game {} final",
            game.name
        );
    }
    assert!(positions > 3000, "{positions}");
    assert!(king_drops > 10, "{king_drops}");
}

#[test]
fn cases_match_tsshogi() {
    let (probes, _, cases) = parse_fixture();
    assert!(cases.len() >= 16);
    for line in cases {
        let fields: Vec<&str> = line.split('|').collect();
        let [_, name, sfen, legal, checks, probed] = fields[..] else {
            panic!("bad case line: {line}");
        };
        let position = parse_sfen(sfen);
        assert_eq!(summary(&legal_moves(&position)), legal, "{name}");
        for check in checks.split(' ') {
            let (usi, result) = check.split_once('=').unwrap();
            let expected = result.chars().next().unwrap();
            assert_eq!(judge(&position, usi.as_bytes()), expected, "{name} {usi}");
        }
        assert_eq!(probe(&position, &probes), probed, "{name} probes");
    }
}

/// 局面に対して USI ごとの見込み (v 合法, i 不正, n 手を作れない) を確かめる
fn expect(sfen: &str, checks: &[(&str, char)]) {
    let position = parse_sfen(sfen);
    for (usi, expected) in checks {
        assert_eq!(judge(&position, usi.as_bytes()), *expected, "{sfen} {usi}");
    }
}

#[test]
fn pawn_drop_mate() {
    expect(
        "7nk/9/7G1/9/9/9/9/9/4K4 b P 1",
        &[("P*1b", 'i'), ("P*5e", 'v'), ("P*2b", 'v')],
    );
    expect(
        "4k4/9/9/9/9/9/1g7/9/KN7 w p 1",
        &[("p*9h", 'i'), ("p*5e", 'v')],
    );
}

#[test]
fn pawn_drop_mate_does_not_ignore_the_king_square() {
    // 本当は 4b へ逃げても飛車に取られるが、玉の升を空けずに利きを見るので 4b が逃げ道になる
    expect("3gsg3/R3k4/9/4G4/9/9/9/9/4K4 b P 1", &[("P*5c", 'v')]);
}

#[test]
fn double_pawn_counts_only_unpromoted_own_pawns() {
    expect(
        "k8/9/5+Pp2/9/9/9/4P4/9/4K4 b P 1",
        &[("P*5e", 'i'), ("P*4e", 'v'), ("P*3e", 'v'), ("P*6a", 'i')],
    );
}

#[test]
fn pieces_without_a_next_move() {
    expect(
        "k8/9/4S4/2S5N/1G4S2/9/9/9/4K4 b LNP 1",
        &[
            ("L*5a", 'i'),
            ("N*5b", 'i'),
            ("P*1a", 'i'),
            ("N*6c", 'v'),
            ("1d2b", 'i'),
            ("1d2b+", 'v'),
            ("7d7c+", 'v'),
            ("5c4d+", 'v'),
            ("3e3d+", 'i'),
            ("3e3d", 'v'),
            ("8e8d+", 'i'),
            ("5i5h+", 'i'),
        ],
    );
    expect(
        "4k4/9/9/9/9/9/9/9/K8 w lnp 1",
        &[
            ("p*5i", 'i'),
            ("n*5h", 'i'),
            ("n*5g", 'v'),
            ("l*5i", 'i'),
            ("l*5h", 'v'),
        ],
    );
}

#[test]
fn two_kings_check_only_the_first_one() {
    // 最初の玉 (5i) だけを見るので、1i が飛車に取られる形でも 9g9f は通る
    expect(
        "8r/9/9/9/9/9/P8/9/4K3K b - 1",
        &[("9g9f", 'v'), ("1i1h", 'i'), ("1i2h", 'v')],
    );
    // 玉を動かす手は行き先の利きだけを見る。最初の玉 (9a) への王手は放っておける
    expect(
        "K8/9/9/9/9/9/4P4/9/r3K4 b - 1",
        &[("5g5f", 'i'), ("5i5h", 'v'), ("9a9b", 'i'), ("9a8a", 'v')],
    );
}

#[test]
fn capturing_a_king_does_not_go_to_the_hand() {
    let mut position = parse_sfen("8r/9/9/9/9/9/P8/9/4K3K w - 1");
    let m = position.move_from_usi(b"1a1i").unwrap();
    assert!(position.is_valid_move(&m));
    assert_eq!(m.captured, KING);
    position.do_move(&m);
    assert_eq!(position.hands, [[0; HAND_TYPES]; 2]);
    assert_eq!(position.king_square(BLACK), square(5, 9));
    assert_eq!(position.turn, BLACK);

    let mut position = parse_sfen("4r4/9/9/9/9/9/9/9/4K4 w - 1");
    position.do_move(&position.move_from_usi(b"5a5i+").unwrap());
    assert_eq!(position.king_square(BLACK), NO_SQUARE);
    assert_eq!(position.cells[square(5, 9) as usize], cell(WHITE, DRAGON));
}

#[test]
fn king_drops_pass_without_a_king_in_hand() {
    expect(
        "4r4/9/9/9/9/9/9/9/4K4 b - 1",
        &[("K*5e", 'v'), ("k*5e", 'v'), ("K*1e", 'i'), ("K*5e+", 'i')],
    );
    // 打った玉が添字順で最初の玉になり、以後はそちらへの王手を見る
    let mut position = parse_sfen("4r4/9/9/9/9/9/9/9/4K4 b - 1");
    position.do_move(&position.move_from_usi(b"K*5e").unwrap());
    assert_eq!(position.king_square(BLACK), square(5, 5));
    assert_eq!(position.hands, [[0; HAND_TYPES]; 2]);
    position.do_move(&position.move_from_usi(b"5a5b").unwrap());
    assert_eq!(judge(&position, b"K*1a"), 'i');
    assert_eq!(judge(&position, b"K*5c"), 'v');
    assert_eq!(judge(&position, b"5i4i"), 'v');
}

#[test]
fn leaving_the_king_in_check() {
    expect(
        "4r4/9/9/9/9/9/P8/5G3/4K4 b G 1",
        &[
            ("9g9f", 'i'),
            ("4h5h", 'v'),
            ("G*5e", 'v'),
            ("G*4e", 'i'),
            ("5i4i", 'v'),
        ],
    );
    expect(
        "4r4/9/9/9/9/9/9/4S4/4K4 b - 1",
        &[("5h4g", 'i'), ("5h5g", 'v'), ("5h6g", 'i')],
    );
}

#[test]
fn king_walking_into_check() {
    expect(
        "5r3/9/9/9/9/9/9/9/4K4 b - 1",
        &[("5i4h", 'i'), ("5i4i", 'i'), ("5i6h", 'v'), ("5i5h", 'v')],
    );
    // 玉の居た升は空けて見るので、利きの筋に沿って下がる手も不正
    expect(
        "4r4/9/9/9/9/9/9/4K4/9 b - 1",
        &[("5h5i", 'i'), ("5h5g", 'i'), ("5h4h", 'v')],
    );
}

#[test]
fn no_own_king_means_no_check() {
    expect(
        "4r4/9/9/9/9/9/9/4S4/9 b - 1",
        &[("5h4g", 'v'), ("K*5i", 'v')],
    );
}

#[test]
fn broken_usi() {
    let position = Position::hirate();
    let cases: &[(&[u8], char)] = &[
        (b"", 'n'),
        (b"7g", 'n'),
        (b"7g7", 'n'),
        (b"7g7f", 'v'),
        (b"7g7fx", 'v'),
        (b"7g7f+", 'i'),
        (b"7G7F", 'n'),
        (b"7g7F", 'n'),
        (b"0g7f", 'n'),
        (b"P*", 'n'),
        (b"P*5e", 'i'),
        (b"p*5e", 'i'),
        (b"K*5e", 'v'),
        (b"k*5e", 'v'),
        (b"X*5e", 'n'),
        (b"+P*5e", 'n'),
        (b"5e5e", 'n'),
        (b"\x7f\x7f\x7f\x7f\0", 'n'),
    ];
    for (usi, expected) in cases {
        assert_eq!(
            judge(&position, usi),
            *expected,
            "{:?}",
            String::from_utf8_lossy(usi)
        );
    }
    // 6 文字目以降は読まない
    assert_eq!(
        position.move_from_usi(b"7g7f+xyz").map(|m| m.promote),
        Some(true)
    );
}

#[test]
fn do_move_updates_the_hand_and_turn() {
    let mut position = parse_sfen("4k4/9/9/9/4+r4/9/9/4R4/4K4 b - 1");
    let m = position.move_from_usi(b"5h5e").unwrap();
    assert_eq!(m.captured, DRAGON);
    assert!(position.is_valid_move(&m));
    position.do_move(&m);
    assert_eq!(position.hands[BLACK as usize][ROOK as usize], 1);
    assert_eq!(position.cells[square(5, 5) as usize], cell(BLACK, ROOK));
    assert_eq!(position.turn, WHITE);

    position.do_move(&position.move_from_usi(b"5a4a").unwrap());
    position.do_move(&position.move_from_usi(b"5e5b+").unwrap());
    assert_eq!(position.cells[square(5, 2) as usize], cell(BLACK, DRAGON));
    position.do_move(&position.move_from_usi(b"4a3a").unwrap());
    position.do_move(&position.move_from_usi(b"R*1e").unwrap());
    assert_eq!(position.hands[BLACK as usize][ROOK as usize], 0);
    assert_eq!(position.cells[square(1, 5) as usize], cell(BLACK, ROOK));
}

#[test]
fn do_move_from_an_empty_square_does_nothing() {
    let mut position = Position::hirate();
    let before = position.clone();
    position.do_move(&Move {
        from: square(5, 5),
        to: square(5, 4),
        piece_type: PAWN,
        color: BLACK,
        promote: false,
        captured: NO_PIECE,
    });
    assert_eq!(position.cells, before.cells);
    assert_eq!(position.turn, BLACK);
}

#[test]
fn broken_moves_are_rejected_without_panicking() {
    let mut position = Position::hirate();
    let broken = [
        Move {
            from: square(7, 7),
            to: 81,
            piece_type: PAWN,
            color: BLACK,
            promote: false,
            captured: NO_PIECE,
        },
        Move {
            from: 90,
            to: square(7, 6),
            piece_type: PAWN,
            color: BLACK,
            promote: false,
            captured: NO_PIECE,
        },
        Move {
            from: NO_SQUARE,
            to: square(5, 5),
            piece_type: 200,
            color: BLACK,
            promote: false,
            captured: NO_PIECE,
        },
    ];
    for m in &broken {
        assert!(!position.is_valid_move(m));
        position.do_move(m);
    }
    assert_eq!(position.cells, Position::hirate().cells);
}
