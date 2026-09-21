# tsshogi-detect

[tsshogi](https://github.com/sunfish-shogi/tsshogi) の拡張パッケージ。局面・棋譜から囲いと戦法を、
指し手から手筋と格言パターンを検出する。
テンプレートエンジン（castle.dart / move_history.dart）と手筋の基礎実装は
[tsshogi-dart](https://github.com/shielune/tsshogi-dart) の TypeScript 移植。

## 囲いと戦法

```ts
import { detectCastles, recordCastles, recordStrategies } from 'tsshogi-detect'

// 局面スナップショットから検出
const detected = detectCastles(record.position)
// => [{ template: { name: '金矢倉', ... }, side: 'black' }]

// 棋譜を走査して「初めて成立した手」を得る
const at = recordCastles(moves)
// => [{ template, side, ply: 34 }]

// 戦法も同じ形で返る
const strategies = recordStrategies(moves)
// => [{ template: { name: '四間飛車', ... }, side: 'black', ply: 12 }]
```

返る配列は成立したものを全部含み、同じ手数で複数成立した組の中は、優先度（`priority`）、
系統の深さ、制約の厳しさ、手数、名前の順に見て並ぶ。狭いことを言っている定義ほど前に出る。

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

照合エンジンと、そこに囲い・戦法という母集団を当てる層に分かれている。
手筋と格言はテンプレート照合を使わず、指し手と前後の局面を直に見る別系統で、
`src/technique.ts` と `src/proverb.ts` に閉じている。

- `src/template.ts` — テンプレートの型 `FormationTemplate`
- `src/requirements.ts` — テンプレートを構成する要件 `TemplateRequirement`（盤上セル / 盤面全体 / 履歴依存）
- `src/move-history.ts` — 棋譜走査中の駒移動履歴（PieceUnmoved / PieceVisited / 居玉 / 打った駒 / 角交換）
- `src/position-history.ts` — 履歴なしで照合するときの擬似履歴（初期位置の駒は動いていないと見なす）
- `src/match.ts` — 1 局面 1 テンプレの照合
- `src/hierarchy.ts` — 系統（`parent`）をたどる親ゲート
- `src/scan.ts` — 棋譜の走査（`recordTemplates`）
- `src/order.ts` — 検出結果の並び順（`priorityOf` / `orderDetections` / `orderDetectionsWithinPly`）
- `src/castle.ts` — 囲いを当てて呼ぶ層。`detectCastles` / `recordCastles`
- `src/castles.gen.ts` — 囲いテンプレート 113 件（生成物、手で編集しない）
- `src/strategy.ts` — 戦法を当てて呼ぶ層。`detectStrategies` / `recordStrategies`
- `src/strategies.gen.ts` — 戦法テンプレート 244 件（生成物、手で編集しない）
- `src/technique.ts` — 手筋 103 件と、その判定。`detectTechniquesAtMove` / `recordTechniques`
- `src/proverb.ts` — 格言パターン 13 件と、その判定。`detectProverbsAtMove` / `recordProverbs`

テンプレートは位置ベースのパターンに加えて、成立手数（`plyEq` / `plyMin` / `plyMax`）、
打って揃えた形の排除（`noDrop`）、角交換の有無と仕掛けた側（`bishopExchange`）、
成立を認める最終手（`finishMoves`）、系統を繋ぐだけの分類の節（`category`）、
同時に成立したときの並び順（`priority`）を指定できる。
同梱の 2 つ以外の母集団も、`detectTemplates` / `recordTemplates` に自分のテンプレート列を
渡せばそのまま扱える。

並び順は成立の可否には関わらず、返す配列の順番だけを変える。同じ手で 2 つ以上成立した
ときは、次の順に見て、差が付いたところで決まる。

1. 優先度（`priority`）。大きいほど前。省略は 0 で、後ろへ回したければ負の数も書ける
2. 系統の深さ。`parent` をたどった代の数が多いほど前
3. 制約の厳しさ。要件の数が多いほど前
4. 手数。若いほど前
5. 名前。文字コードの昇順

2 と 3 は「狭いことを言っている定義ほど代表にしたい」という同じ考えの二段構え。
並べ替えるのは同じ手数の中だけで、手数は今までどおり主たる順序のまま。

`category: true` を書いた節（`振り飛車` `居飛車` `その他`）は系統を繋ぐためだけに
あり、検出としては返らない。`四間飛車` が成立していれば振り飛車であることは `parent`
を辿れば分かる。

囲いと戦法で走査の細目だけが違う。戦法は成立を指した側に限り（`moverOnly`）、親が
成立していない子を落とす（`requireParent`）。囲いは代わりに、ちゃんとした囲いが成立して
いる陣営には居玉を出さない（`suppressGameEndIfDetected`）。

## データの再生成

テンプレートの正は `data/castles.txt` と `data/strategies.txt`（bioshogi 由来の構造化データ、
tsshogi-dart と共通）。定義エディタで編集した分は、親アプリがデータベースから
この 2 つへ書き戻す。

`src/*.gen.ts` はその 2 つから書き出す。

```
bun run generate
```

読むのは同梱の解析器（`parseTemplateFile`）なので、拡張記法（`finish:` `category:`
`?` による OR 指定、`no_drop:` `bishop_exchange:`）もそのまま通る。
`data/*.txt` を変更したら再生成してコミットする。

## 版の差分

どのテンプレートが増えたか、どの定義が変わったかを版どうしで比べる。
`CHANGELOG.md` の「足したもの」「変えたもの」はこの出力から書き起こしている。

```
bun run scripts/diff-templates.ts v0.1.0           # その版と作業ツリー
bun run scripts/diff-templates.ts v0.1.0 v0.2.0    # 版どうし
bun run scripts/diff-templates.ts v0.1.0 --all     # 名前を省略せず全部出す
```

## 検証

囲いは Python 実装（app/shogi、同じ Dart 移植）との差分検査で、実戦 1500 局・囲い延べ 3583 件の
`recordCastles` が両方向で完全一致することを確認済み。
手筋 103 件の名前・順序と格言 13 件の名前・relation も Python 実装と一致する。

```sh
bun test
bun run typecheck
```

## スコープ

- 囲いと戦法: 局面・棋譜から成立形を検出する。同梱するテンプレートは囲い 113 件と戦法 244 件。
- 手筋: 1 手と前後の局面だけで機械的に判定できるものを扱う。103 件。
- 格言: 盤上で確認できるパターンと関係だけを扱い、手の善悪は評価しない。13 件。
- 「あと一手で完成」のような解説向けの派生判定はこのパッケージには含めない。
