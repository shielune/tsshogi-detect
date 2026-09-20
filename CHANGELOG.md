# 変更履歴

版ごとの変わりどころ。テンプレートの増減と定義の変更は
`bun run scripts/diff-templates.ts <前の版>` の出力から書き起こしている。

## 0.2.0 (2026-09-20)

### 足したもの

- 戦法テンプレート 244 件 (`KNOWN_STRATEGIES`) と、それを当てる `detectStrategies` /
  `recordStrategies` / `findStrategy`。これまで戦法データは親アプリ側にしか無く、
  このライブラリだけでは戦法が判定できなかった。
- テンプレートに書ける語彙:
  - `plyEq` / `plyMin` / `plyMax` 成立手数の制限
  - `noDrop` 打って揃えた形を成立と認めない
  - `bishopExchange` 角交換の有無と、仕掛けた側
  - `finishMoves` 成立を認める最終手 (移動元、着地、打ち、取った駒、成り)
  - `category` 盤の形を持たない分類の節。子孫が成立した陣営で成立する
  - `PieceInSquares` 挙げた升のどれかに居ればよい駒
- 母集団を選ばない入口 `detectTemplates` / `recordTemplates`。走査の細目は
  オプションで選ぶ (`moverOnly` / `requireParent` / `rollUpCategories` など)。
  囲いと戦法はこれを呼ぶ薄い層になった。
- 定義の写し `data/castles.txt` / `data/strategies.txt`。ここに txt を読むパーサは
  無く、ライブラリが使うのは `src/*.gen.ts` のほう。写しは人が読むために置いてある。
- 版どうしを比べる `scripts/diff-templates.ts`。

### 変えたもの

- 型 `CastleTemplate` を `FormationTemplate` に改名した。`CastleTemplate` は別名と
  して残してあるので、既存の import は壊れない。`detectCastles` / `recordCastles`
  も従来どおり。
- 囲いの定義 2 件を最新の定義から作り直した (件数は 113 件のまま)。
  - 四枚穴熊 — 盤の形、最終手
  - 片美濃囲い — 盤の形

## 0.1.0 (2026-08-21)

- tsshogi-dart の囲い検出を TypeScript へ移した初版。囲いテンプレート 113 件
  (`KNOWN_CASTLES`) と `detectCastles` / `recordCastles` / `findCastle`。
