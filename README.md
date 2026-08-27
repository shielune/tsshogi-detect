# tsshogi-detect

[tsshogi](https://github.com/sunfish-shogi/tsshogi) の拡張パッケージ。局面・棋譜から囲い、指し手から手筋と格言パターンを検出する。
囲いと手筋の基礎実装は [tsshogi-dart](https://github.com/shielune/tsshogi-dart) の TypeScript 移植。

## 囲い

```ts
import { detectCastles, recordCastles } from 'tsshogi-detect'

// 局面スナップショットから検出
const detected = detectCastles(record.position)
// => [{ template: { name: '金矢倉', ... }, side: 'black' }]

// 棋譜を走査して「初めて成立した手」を得る
const at = recordCastles(moves)
// => [{ template, side, ply: 34 }]
```

## 手筋

手筋は直前の指し手と、その前後の局面から判定する。`KNOWN_TECHNIQUES` には 103 件を収録している。

```ts
import { detectTechniquesAtMove, recordTechniques } from 'tsshogi-detect'

const before = position.clone()
position.doMove(move, { ignoreValidation: true })
const techniques = detectTechniquesAtMove(move, before, position)
// => [{ name: 'たたきの歩', aliases: ['叩きの歩'], matches: ... }, ...]

// 棋譜全体。同じ手筋が複数回出ればその都度返す
const at = recordTechniques(moves)
// => [{ template, color: 'black', ply: 42 }, ...]
```

同じ `(手筋名, 陣営)` を最初の 1 回だけ取得する場合は `recordTechniquesFirstOccurrence` を使う。
`連打の歩` と `継ぎ歩` のように直前手より前の履歴が必要なものは、現在の単手 API では検出しない。

## 格言パターン

格言は「この手が好手である」といった価値判断をせず、盤上から機械的に確認できる関係だけを返す。
`relation` は `follows` / `pattern` / `state` / `violates` の 4 種。

```ts
import { detectProverbsAtMove } from 'tsshogi-detect'

// 手筋結果を渡すと再検出を省ける
const proverbs = detectProverbsAtMove(move, before, position, techniques)
// => [{ name: '焦点の歩に好手あり', relation: 'pattern', matches: ... }]
```

たとえば `pattern` は格言に典型的な形であることだけを意味し、その手の評価を保証しない。
棋譜全体を走査する場合は `recordProverbs(moves)` を使う。

## 構成

- `src/requirements.ts` — 囲いテンプレートを構成する要件 9 種（盤上セル / 盤面全体 / 履歴依存）
- `src/move-history.ts` — 棋譜走査中の駒移動履歴（PieceUnmoved / PieceVisited / 居玉判定が参照）
- `src/castle.ts` — `detectCastles`（スナップショット）/ `recordCastles`（初成立 ply 付き）
- `src/castles.gen.ts` — 囲いテンプレート 113 件（生成物、手で編集しない）
- `src/technique.ts` — 手筋 103 件と単手・棋譜走査 API
- `src/proverb.ts` — 格言パターン 13 件と単手・棋譜走査 API

## データの再生成

囲いテンプレートの正は `data/castles.txt`（bioshogi 由来の構造化データ、tsshogi-dart と共通）。
`src/castles.gen.ts` は現状、親アプリ側の `scripts/kifu/generate_castles_ts.py`（Python パーサ経由）で
生成している。テンプレートを変更したらそちらで再生成してコミットする。

## 検証

囲いは Python 実装（app/shogi、同じ Dart 移植）との差分検査で、実戦 1500 局・囲い延べ 3583 件の
`recordCastles` が両方向で完全一致することを確認済み。
手筋 103 件の名前・順序と格言 13 件の名前・relation も Python 実装と一致する。

```sh
bun test
bun run typecheck
```

## スコープ

- 囲い: 局面・棋譜から成立形を検出する。
- 手筋: 1 手 + 前後局面で機械的に判定できるものを扱う。
- 格言: 盤上で確認できるパターンと関係だけを扱い、手の善悪は評価しない。
- 戦型（strategies）は未移植。
- 「あと一手で完成」のような解説向け派生判定はこのパッケージには含めない。
