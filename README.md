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

照合エンジンと、そこに囲いという母集団を当てる層に分かれている。

- `src/template.ts` — テンプレートの型 `FormationTemplate`（`CastleTemplate` はその別名）
- `src/requirements.ts` — テンプレートを構成する要件（盤上セル / 盤面全体 / 履歴依存）
- `src/move-history.ts` — 棋譜走査中の駒移動履歴（PieceUnmoved / PieceVisited / 居玉 / 打った駒 / 角交換）
- `src/position-history.ts` — 履歴なしで照合するときの擬似履歴（初期位置の駒は動いていないと見なす）
- `src/match.ts` — 1 局面 1 テンプレの照合
- `src/hierarchy.ts` — 系統（`parent`）をたどる親ゲートとカテゴリの巻き上げ
- `src/scan.ts` — 棋譜の走査（`recordTemplates`）
- `src/castle.ts` — 囲いを当てて呼ぶ層。`detectCastles` / `recordCastles`
- `src/castles.gen.ts` — 囲いテンプレート 113 件（生成物、手で編集しない）

テンプレートは位置ベースのパターンに加えて、成立手数（`plyEq` / `plyMin` / `plyMax`）、
打って揃えた形の排除（`noDrop`）、角交換の有無と仕掛けた側（`bishopExchange`）、
成立を認める最終手（`finishMoves`）、盤の形を持たない分類の節（`category`）を指定できる。
囲い以外の母集団（戦法など）は `detectTemplates` / `recordTemplates` に自分のテンプレート列を
渡せばそのまま扱える。

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

同梱するテンプレートデータは囲い 113 件のみ。戦型（strategies）・手筋（techniques）は
エンジンとしては扱えるが、データは未移植。
「あと一手で完成」のような解説向けの派生判定はこのパッケージには含めない。
