# 変更履歴

版ごとの変わりどころ。定義の増減と中身の変更は
`bun run scripts/diff-definitions.ts <前の版>` の出力から書き起こしている。

## 0.9.0 (2026-10-02)

### 足したもの

- `igyoku: false`。条件なしと区別し、居玉ではないことを要求する。
  玉が歩・角以外の最初の駒取りより前に動いていれば満たす。
  `igyoku: true` の終局評価と、ヘッダ省略時の意味は変わらない。
- `opponent_hand:`。判定する側の相手の持駒を要求する。書き方は既存の `hand:` と同じで、
  `opponent_hand: B*2 P` は角 2 枚以上と歩 1 枚以上を要求する。
- 要件は `KingIgyoku(false)` と `HandPiece(pieceType, minCount, Color.WHITE)` で作れる。
  既存の引数を省略した使い方はそのまま動く。
- DSL の要件を付け外しするヘルパーと、TypeScript・Rust/WASM の走査を同じ条件へ対応させた。
  差分走査は相手の持駒が増えたときと玉が動いたときの索引から候補を拾う。

### 使う側が知っておくこと

- 以前の `igyoku: false` は条件を作らなかったが、この版から否定条件になる。
  条件なしを意図している定義ではヘッダを省略する。
- パーサの中間表現に `kingNotIgyoku` と `opponentHandPiece` を足した。
  中間表現を自分で要件へ変換しているアプリは、この 2 種類も扱う必要がある。
- 同梱の既存定義と、従来の肯定条件の意味は変更していない。

## 0.8.0 (2026-09-29)

### 足したもの

- `compilePair(castles, strategies)` と `CompiledPair`。囲いと戦法のように名前も親子も別々に
  扱う 2 組を、棋譜を 1 回指すだけで走査する。組ごとに options を変えられ、答えは
  別々に `compile` して回したものと 1 語も違わない (`test/wasm.test.ts` で突き合わせている)。
  `recordMany(games, firstOptions, secondOptions)` が `[1 組めの答え, 2 組めの答え]` を返す。
  - WASM には `compile_pair` と `scan_pair` を足した。`compile` と `scan` は変わらない。
  - Rust の `Scanner::group` と `scan_group` が本体で、集まりは 1 つ以上を持てる。

### 速くしたもの

走査の結果は変わらない。250 万局 (249 万 2,167 局) の全局で、検出の数・合法な手の数・照合値が
0.7.1 と完全に一致した。

- 駒が来た升に置けない照合は、候補に入れない。手数の窓を過ぎた照合は索引ごと切る。
  升の照合は、落ちやすいもの (置ける中身が少ない升) から先に見る。
- 升の照合は、定義ごとに「成り立っている升の数」を持って数え上げる。1 手で変わるのは
  移動元と移動先の 2 升だけなので、その 2 升に効く照合の数だけを足し引きし、数が揃った
  照合だけを候補にする。
- 実棋譜で測ると、Rust 単体は 10 万局で 10.7 秒から 3.5 秒 (囲いと戦法を `compilePair` で
  1 回にまとめると 2.9 秒)、250 万局で 244.5 秒から 79.9 秒。WASM を通した 1 局あたりは
  147µs から 37µs。

### 使う側が知っておくこと

- 照合の表が大きくなり、WASM の線形メモリが 1 つの走査器で 1.4MB から 4.9MB になる
  (囲い・戦法の 2 組を読んだとき)。線形メモリは縮まないので、ワーカを並べて使うなら
  本数ぶん増える。表を作るときに一時の配列は作らない。
- ワーカを並べる場合、本数は増やすほど速いとは限らない。10 万局でワーカ 8 本が 0.61 秒、
  19 本が 0.72 秒だった (20 コアの計測機)。

## 0.7.1 (2026-09-29)

### 直したもの

- WASM の走査器を組むときの型。バイト列を `WebAssembly.instantiate` に直接渡すのを
  やめ、`compile` してから `instantiate` する。使う側が `@cloudflare/workers-types` と
  `bun-types` を一緒に読むと多重定義が Module を渡す形に解決され、`tsc` が
  `src/wasm/scanner.ts` で落ちていた。実行時の挙動は変わらない。

## 0.7.0 (2026-09-29)

### 足したもの

- WASM の走査器 (`tsshogi-detect/wasm`)。`loadScanner()` で組み、`compile(definitions)`
  した上で `record` / `recordWithDropped` / `recordMany` / `recordManyWithDropped` を
  呼ぶ。結果は `recordDefinitions` / `recordDefinitionsWithDropped` と同じで、返る
  `definition` は渡したオブジェクトそのもの。平手から始まる USI の棋譜だけを扱い、
  符号にできない定義は `UnsupportedDefinitionError` で断る (TS 版に戻す合図)。
  - 走査器は `rust/` にあり、`bun run build:wasm` で `src/wasm/scanner.gen.ts` に埋める。
  - `bun run scripts/bench-wasm.ts` で TS 版と 1 局あたりの時間を比べられる。
  - 実際の棋譜 (1 行 1 局の USI) で測るときは `scripts/bench-wasm-kifu.ts` (bun でも
    node でも動く) と `rust/examples/bench.rs` (WASM にしない Rust そのもの) を使う。
    定義は `scripts/bench-definitions.ts` がアプリの dev サーバから取って控え、
    `scripts/bench-encode-definitions.ts` が走査器の符号にして両方へ渡す。250 万局の
    棋譜で 1 局あたり WASM 0.13 ms、Rust 0.097 ms (元の TS 版は 2 万局の標本で 4.5 ms)。
    標本 2 万局では 3 つの結果が一致し、Rust と WASM は 250 万局の全局で一致した。
- `gateParents` (`src/hierarchy.ts`) と `definitionOrderTiers` (`src/order.ts`)。
  親ゲートの相手と、同じ手数の中での順位を、定義ごとに前もって求める。走査器へ
  渡すためのもので、TS 版の走査の挙動は変わらない。

## 0.6.0 (2026-09-27)

### 足したもの

- 相手駒の除外 (`[!r]`)。括弧の中を小文字で書くと「その升に相手のその駒が居ない」
  という要件になる。空升・自分の駒・相手の別の駒は満たす。`[!GS]` が相手の金銀を
  通すのと同じ考えで、色が逆になっただけ。
  - パーサの読んだ形は新しい kind の `opponentNotOf`。`NotOfPieces` は 4 つめの引数に
    色を取るようになった (省略は今までどおり自駒)。
  - 盤面エディタ向けのセル (`DefinitionCell`) も相手駒の除外を持てる。`flipCellSide`
    は除外なら何駒並んでいても先後を入れ替える。
- 角交換をしていないことの要求 (`bishop_exchange: never`)。角交換が済んだ局面では
  成立させない。`false` は「問わない」とも読めるので受けない。

### 変えたもの (使う側の書き直しが要る)

- 升の括弧の中で大文字と小文字を混ぜられなくなった (`[Gs]` `[!Gs]`)。小文字を
  書けるのは除外だけで、並べる側 (`[gs]`) は書けない。今までは色を見ずに自駒として
  読んでいた。`data/` の定義には当てはまるものが無いので、囲いと戦法の中身は
  変わらない。
- 最終手の取った駒 (`finish: … x [br]`) は今までどおり大文字と小文字を区別しない。
  取った駒には色が無いので、升と違って小文字の並びも混ぜ書きも同じ意味で通す。

## 0.5.0 (2026-09-22)

### 変えたもの (使う側の書き直しが要る)

- 囲いと戦法の「テンプレート」を「定義」と呼び直した。書き出す名前から `Template` が
  消えて `Definition` になる。盤の形を書いた DSL の本文と、`data/` に入っている
  囲い 113 件・戦法 244 件の中身は一字も変わっていない。読み替えは次のとおり。
  - `FormationTemplate` は `FormationDefinition`、`StrategyTemplate` は
    `StrategyDefinition`。
  - `ParsedTemplate` は `ParsedDefinition`、`parseTemplateFile` は
    `parseDefinitionFile`、`TemplateSyntaxError` は `DefinitionSyntaxError`。
  - `TemplateSquare` `TemplateCell` `TemplateGrid` `TemplateRequirement` は
    それぞれ `Definition` 始まりへ。`TemplateFinishCapture` と `TemplateFinishMove`
    も同じ。
  - `DetectedTemplate` と `DetectedTemplateAt` は `DetectedDefinition` と
    `DetectedDefinitionAt`。**持っている項目の名前も `template` から `definition`
    へ変わる**。
  - `detectTemplates` `matchesTemplate` `recordTemplates`
    `recordTemplatesWithDropped` `ancestorTemplates` `readTemplateName`
    `setTemplateName` は、いずれも同じ規則で `Definition` 側へ。
    `RecordTemplatesOptions` は `RecordDefinitionsOptions`。
- 手筋の `TechniqueTemplate` は `TechniqueMatcher` にした。こちらは盤の形ではなく
  コードで書いた判定器なので、定義とは呼ばない。`DetectedTechnique` が持つ項目も
  `template` から `matcher` へ変わる。格言の側は元から `pattern` なので変わらない。
- `scripts/generate-templates.ts` は `scripts/generate-definitions.ts`、
  `scripts/diff-templates.ts` は `scripts/diff-definitions.ts` に改名した。

## 0.4.1 (2026-09-22)

### 直したもの

- `orderDetectionsWithinPly` が、添字で取り出した要素を undefined になりうる値として
  扱っていなかった。`noUncheckedIndexedAccess` を立てている側から使うと型検査で落ちる。
  返す並びは変わらない。
- この版から型検査でも `noUncheckedIndexedAccess` を立てる。使う側の設定でだけ落ちる
  書き方が入らないようにするため。

## 0.4.0 (2026-09-21)

### 足したもの

- テンプレートの優先度 (`priority:`)。同じ手で複数の囲いや戦法が成立したとき、
  返す配列の**どこに置くか**を定義の側から言えるようにした。大きいほど前に出る。
  省略は 0 なので、既存の囲い 113 件と戦法 244 件は 1 行も変わっていない。
  後ろへ回したければ負の数も書ける。
  - **落とす数は変えない**。成立したものは今までどおり全部返り、順番だけが変わる。
  - 成立の可否には関わらないので、盤の形を持たない分類の節 (`category: true`) にも
    書ける。
- 同じ手で 2 つ以上成立したときの並び順を決め切った。優先度、系統の深さ、制約の
  厳しさ、手数、名前の順に見て、差が付いたところで決まる。定義ファイルの並びや
  走査の都合では決まらなくなり、同じ棋譜からは必ず同じ順が返る。
  - 系統の深さは `parent` をたどった代の数、制約の厳しさは要件の数で測る。どちらも
    「狭いことを言っている定義ほど代表にしたい」という同じ考えの二段構え。
  - 並べ替えるのは**同じ手数の中だけ**。`recordCastles` / `recordStrategies` では
    手数が今までどおり主たる順序になる。手数を持たない `detectCastles` /
    `detectStrategies` は配列全体が対象。
- 並べ替える関数 `orderDetections` / `orderDetectionsWithinPly`、テンプレ 1 件の
  優先度を読む `priorityOf`、系統の深さを数える `ancestorDepths`。自前のテンプレート列を
  `detectTemplates` / `recordTemplates` に渡している側も同じ並びを作れる。

### 変えたもの

- **分類の節 (`category: true`) を検出として返さなくなった**。`振り飛車` `居飛車`
  `その他` の 3 件は系統を繋ぐためだけの節になり、`recordStrategies` /
  `detectStrategies` の結果から消える。`四間飛車` が出ていれば振り飛車であることは
  `parent` を辿れば分かるので、同じことを 2 通りで返すのをやめた。
  - 具体の定義の成立は今までどおり。親ゲートでの素通し (`gateParent`) も変わらない。
  - 巻き上げる関数 `categoryRollup` と、走査の `rollUpCategories` オプションを外した。

## 0.3.0 (2026-09-20)

### 足したもの

- 手筋 103 件 (`KNOWN_TECHNIQUES`) と、1 手ごとに判定する `detectTechniquesAtMove`、
  棋譜を走査する `recordTechniques` / `recordTechniquesFirstOccurrence`。
  tsshogi-dart から移した 94 件に、1 手と前後の局面だけで客観的に判定できる 9 件を足した。
  `連打の歩` と `継ぎ歩` のように直前手より前の履歴が要るものは、まだ扱わない。
- 格言パターン 13 件 (`KNOWN_PROVERBS`) と `detectProverbsAtMove` / `recordProverbs`。
  手が好手かどうかは判定せず、盤上で確かめられる関係 (`follows` / `pattern` /
  `state` / `violates`) だけを返す。
- テンプレート定義ファイル (`data/*.txt`) の解析器。`parseTemplateFile` が定義文の
  全体を読み、`tryParseCellToken` が升のトークン 1 つを読む。`TemplateSyntaxError` は
  行番号を持つので、定義を書く側に場所を返せる。拡張記法 (`finish:` `category:`
  `?` による OR 指定、`no_drop:` `bishop_exchange:`) もここで解く。
- 定義文を機械的に編集するための道具立て。升のトークンと `TemplateCell` を行き来する
  `cellFromToken` / `tokenFromCell` / `normalizeCell` / `flipCellSide`、盤面の格子を
  取り出して升を差し替える `extractGrid` / `replaceCellToken` / `replaceCellTokens`、
  ヘッダ行を読み書きする `readTemplateName` / `setTemplateName` / `setHeaderField` /
  `insertHeaderLine`、ヘッダ由来の要件を足し引きする `addHeaderRequirement` /
  `updateHeaderRequirement` / `removeHeaderRequirement`。
- `data/*.txt` から `src/castles.gen.ts` / `src/strategies.gen.ts` を書き出す生成器
  (`bun run generate`)。これまで定義ファイルは当リポジトリに置きながら、それを読む
  解析器と生成器は親アプリ側にあった。解析器がこちらに来たので、生成もこちらで完結する。

手筋と格言はテンプレート照合を通さない別系統なので、`scripts/diff-templates.ts` の
対象には入らない。

### 壊したもの

囲いだけを扱っていた頃の名前を落とした。移し替えは名前を置き換えるだけで済む。

- 型 `CastleTemplate` を廃止した。`FormationTemplate` を使う。
- 型 `CastleRequirement` を `TemplateRequirement` に改名した。旧名は残していない。
- `src/castle.ts` から `hasPlyConstraint` / `hasHistoryRequirement` /
  `satisfiesPlyConstraint` / `matchesTemplate` の再輸出を外した。実体は `src/match.ts`
  にあり、パッケージの入口 (`src/index.ts`) からは今までどおり引ける。
  `tsshogi-detect/src/castle.ts` を直に指している import だけが影響を受ける。

`detectCastles` / `recordCastles` / `findCastle` / `KNOWN_CASTLES` は変わっていない。
テンプレートの `aliases` (囲いや戦法の別名) も、これとは別の話なのでそのまま。

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
