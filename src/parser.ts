// ASCII テンプレ → 中間表現パーサ (scripts/lib/shogi/template_parser.py の TS 移植)。
//
// 囲い・戦法を定義する DSL (利用側リポジトリの castles.txt / strategies.txt などが
// 書く書式) の本文をパースする。定義エディタがブラウザ (編集中の逐次バリデーション) と
// Workers (保存時の再バリデーション) の両方で使うため、Python 版と受理・拒否が
// 一致するように移植した。
//
// ファイル仕様:
// - `=== name: <名前>` でセクション開始
// - グリッドより前に `key: value` のヘッダを置ける
//   (parent / aliases / side / category / board / hand / ply / unmoved / visited /
//    igyoku / evaluate_at_game_end / bishop_exchange / description)
// - 続く 9 行 x 9 セルが盤面。行は上 (1 段目) から、列は左 (9 筋) から
// - `category: true` のセクションだけは例外で、グリッドを持たない (盤の形を持たない
//   分類の節)。成立条件のヘッダも書けない — 詳細は parser-header.ts の CATEGORY_FORBIDDEN
// - セルトークン: `.` 無指定 / `_` 空 / `*` 自駒任意 / 大文字 自駒指定 /
//   小文字 相手駒指定 / `[GS]` いずれか / `[!GS]` 除外 / `+P` 成駒
// - `?` を頭に付けると**升をまたいだ OR** になる (`?r` = 印を付けた升のどこか 1 つに
//   相手の飛車)。同じ駒指定の `?` セルは 1 つの要件にまとまる — 対振り持久戦のような
//   「相手が振り飛車である」を書くための唯一の手段
// - `#` と `//` から行末までコメント
//
// 中身は複数ファイルに分かれている: 中間表現と共通ユーティリティ (parser-types.ts) /
// セルトークンの解析 (parser-cell-token.ts) / `finish:` の解析 (parser-finish.ts) /
// それ以外のヘッダとセクション状態 (parser-header.ts)。このファイルは行のディスパッチ
// (セクション区切り・ヘッダ・グリッド行の見分け) と、読み終えたセクションを
// ParsedTemplate に固める finalizeSection を持ち、公開 API はここへまとめて出す。

import type { PieceType } from 'tsshogi'
import {
  cell,
  type ParsedFinishMove,
  type ParsedTemplate,
  type PlacementCell,
  type PlacementKind,
  SFEN_PIECES,
  TemplateSyntaxError,
} from './parser-types.ts'
import { parseCellToken, type CellTokenParse, tryParseCellToken } from './parser-cell-token.ts'
import { applyHeader, checkCategorySection, newSection, parseHeaderLine, type Section } from './parser-header.ts'
import type { TemplateSquare } from './template.ts'

export { SFEN_PIECES, TemplateSyntaxError, tryParseCellToken }
export type { CellTokenParse, ParsedFinishMove, ParsedTemplate, PlacementCell, PlacementKind }

/** `#` または `//` 以降を落とす。トークンにこれらの文字は出てこない。 */
export function stripComments(line: string): string {
  const hashIdx = line.indexOf('#')
  const slashIdx = line.indexOf('//')
  const cut = Math.min(hashIdx >= 0 ? hashIdx : line.length, slashIdx >= 0 ? slashIdx : line.length)
  return line.slice(0, cut)
}

function finalizeSection(section: Section, endLine: number, results: ParsedTemplate[]): void {
  if (section.name === null) return
  if (section.category) {
    checkCategorySection(section)
  } else if (section.gridRows.length !== 9) {
    throw new TemplateSyntaxError(
      `section "${section.name}": expected 9 grid rows, got ${section.gridRows.length}`,
      section.startLine,
    )
  }
  const placements: PlacementCell[] = []
  // `?X` は 1 セル = 1 要件にならない。同じ駒指定のセルを 1 件の OR にまとめるため、
  // 走査中は「駒指定 → 升」で溜めておいて、グリッドを読み終えてから並べる
  const orGroups = new Map<
    string,
    { kind: PlacementKind; pieces: readonly PieceType[]; squares: TemplateSquare[] }
  >()
  for (const [rowIdx, row] of section.gridRows.entries()) {
    if (row.cells.length !== 9) {
      throw new TemplateSyntaxError(
        `section "${section.name}": expected 9 cells at row ${rowIdx + 1}, got ${row.cells.length}`,
        row.line,
      )
    }
    const rank = rowIdx + 1 // 上から下へ
    for (const [colIdx, token] of row.cells.entries()) {
      if (token === '.') continue
      const file = 9 - colIdx // 左から右へ = 9 筋から 1 筋へ
      const { kind, pieceTypes } = parseCellToken(token, section.name, rowIdx + 1, row.line)
      if (kind === 'pieceInSquares' || kind === 'opponentInSquares') {
        // 群の識別は駒指定そのもの。`?[GS]` と `?[SG]` は同じ群に落ちる
        const key = `${kind}:${[...pieceTypes].sort().join(',')}`
        const group = orGroups.get(key) ?? { kind, pieces: pieceTypes, squares: [] }
        group.squares.push({ file, rank })
        orGroups.set(key, group)
        continue
      }
      placements.push(cell(kind, { file, rank, pieceTypes }))
    }
  }
  // OR はグリッドの後・ヘッダ由来の前。群の順は最初に現れた順 (Map の挿入順)
  for (const group of orGroups.values()) {
    placements.push(cell(group.kind, { pieceTypes: group.pieces, squares: group.squares }))
  }
  // board:/hand:/visited: 等のヘッダ由来要件はグリッドの後ろに連結する (順序は決定論的)。
  placements.push(...section.extras)
  results.push({
    name: section.name,
    parent: section.parent,
    aliases: section.aliases,
    side: section.side,
    category: section.category,
    placements,
    plyEq: section.plyEq,
    plyMin: section.plyMin,
    plyMax: section.plyMax,
    evaluateAtGameEnd: section.evaluateAtGameEnd,
    noDrop: section.noDrop,
    bishopExchange: section.bishopExchange,
    finishMoves: section.finishMoves,
    sourceStartLine: section.startLine,
    sourceEndLine: endLine,
  })
}

/** テンプレファイル本文をパースする。 */
export function parseTemplateFile(content: string): ParsedTemplate[] {
  const results: ParsedTemplate[] = []
  const lines = content.split('\n')
  const state = { section: newSection() }

  for (const [i, raw] of lines.entries()) {
    const lineNo = i + 1
    const stripped = stripComments(raw).trim()
    if (stripped === '') continue

    if (stripped.startsWith('===')) {
      if (state.section.name !== null) {
        finalizeSection(state.section, lineNo - 1, results)
      }
      state.section = newSection()
      const { key, value } = parseHeaderLine(stripped.slice(3).trimStart(), lineNo)
      if (key !== 'name') {
        throw new TemplateSyntaxError(`expected "=== name: <name>", got "${stripped}"`, lineNo)
      }
      state.section.startLine = lineNo
      state.section.name = value
      continue
    }

    if (state.section.name === null) {
      throw new TemplateSyntaxError(`content outside of any section: "${stripped}"`, lineNo)
    }

    // ヘッダはグリッドより前にしか現れない。
    if (state.section.gridRows.length === 0 && stripped.includes(':')) {
      const { key, value } = parseHeaderLine(stripped, lineNo)
      applyHeader(state.section, key, value, lineNo)
      continue
    }

    state.section.gridRows.push({ cells: stripped.split(/\s+/), line: lineNo })
  }

  if (state.section.name !== null) {
    finalizeSection(state.section, lines.length, results)
  }
  return results
}
