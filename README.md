# tsshogi-detect

[tsshogi](https://github.com/sunfish-shogi/tsshogi) の拡張パッケージ。局面・棋譜から囲いを検出する。
[tsshogi-dart](https://github.com/shielune/tsshogi-dart) のテンプレートエンジン（castle.dart / move_history.dart）の TypeScript 移植。

```ts
import { Record } from 'tsshogi'
import { detectCastles, recordCastles } from 'tsshogi-detect'

// 局面スナップショットから検出
const detected = detectCastles(record.position)
// => [{ template: { name: '金矢倉', ... }, side: 'black' }]

// 棋譜を走査して「初めて成立した手」を得る
const at = recordCastles(moves)
// => [{ template, side, ply: 34 }]
```

## 構成

- `src/requirements.ts` — テンプレートを構成する要件 9 種（盤上セル / 盤面全体 / 履歴依存）
- `src/move-history.ts` — 棋譜走査中の駒移動履歴（PieceUnmoved / PieceVisited / 居玉判定が参照）
- `src/castle.ts` — `detectCastles`（スナップショット）/ `recordCastles`（初成立 ply 付き）
- `src/castles.gen.ts` — 囲いテンプレート 113 件（生成物、手で編集しない）

## データの再生成

テンプレートの正は `data/castles.txt`（bioshogi 由来の構造化データ、tsshogi-dart と共通）。
`src/castles.gen.ts` は現状、親アプリ側の `scripts/kifu/generate_castles_ts.py`（Python パーサ経由）で
生成している。テンプレートを変更したらそちらで再生成してコミットする。

## 検証

Python 実装（app/shogi、同じ Dart 移植）との差分検査で、実戦 1500 局・囲い延べ 3583 件の
`recordCastles` が両方向で完全一致することを確認済み。

```
bun test
bun run typecheck
```

## スコープ

囲い検出のみ。戦型（strategies）・手筋（techniques）は将来ここに足せる設計だが未移植。
「あと一手で完成」のような解説向けの派生判定はこのパッケージには含めない。
