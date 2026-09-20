// DSL 本文中のグリッド 9 行 x 9 セルを「文字オフセット」で捉えるユーティリティ。
//
// 定義エディタの盤面がセルを書き換えるとき、行をトークン配列から組み直すと
// インデント・桁揃え・行内コメントが失われて textarea が全行 diff になる。
// そこで該当トークンの範囲だけを差し替える。触っていないセルは 1 文字も動かない。
//
// 走査順は parser.ts の parseTemplateFile と同一にすること。ズレるとエディタと
// 検出エンジンで「どの行がグリッドか」の解釈が割れる。

import { stripComments } from './parser.ts'

/** グリッド 1 セル分のトークンと、行内での文字範囲 (end は排他)。 */
export type CellSpan = {
  readonly token: string
  readonly start: number
  readonly end: number
}

/** グリッド 1 行。cells はちょうど 9 個。 */
export type GridRow = {
  /** dsl.split('\n') での添字 (0 始まり)。 */
  readonly lineIndex: number
  readonly cells: readonly CellSpan[]
}

/** rows はちょうど 9 行。上から 1 段目、左から 9 筋。 */
export type TemplateGrid = {
  readonly rows: readonly GridRow[]
}

export type GridExtraction =
  | { readonly ok: true; readonly grid: TemplateGrid }
  | { readonly ok: false; readonly message: string }

type ScanState = {
  readonly sections: number
  readonly rows: readonly GridRow[]
  readonly failure: string | null
}

const INITIAL: ScanState = { sections: 0, rows: [], failure: null }

function cellSpansOf(body: string): CellSpan[] {
  return [...body.matchAll(/\S+/g)].map((match) => ({
    token: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }))
}

function scanLine(state: ScanState, raw: string, lineIndex: number): ScanState {
  if (state.failure !== null) return state

  const body = stripComments(raw)
  const stripped = body.trim()
  if (stripped === '') return state

  if (stripped.startsWith('===')) {
    if (state.sections >= 1) {
      return { ...state, failure: 'テンプレが 2 件以上ある。盤面で編集できるのは 1 件のときだけ' }
    }
    return { ...state, sections: 1 }
  }

  if (state.sections === 0) {
    return { ...state, failure: `セクションの外に本文がある: "${stripped}"` }
  }

  // ヘッダはグリッドより前にしか現れない (parser.ts と同じ条件)。
  if (state.rows.length === 0 && stripped.includes(':')) return state

  const cells = cellSpansOf(body)
  if (cells.length !== 9) {
    return { ...state, failure: `${lineIndex + 1} 行目のセルが 9 個ではない (${cells.length} 個)` }
  }
  if (state.rows.length >= 9) {
    return { ...state, failure: 'グリッドが 9 行を超えている' }
  }
  return { ...state, rows: [...state.rows, { lineIndex, cells }] }
}

/** DSL 本文からグリッドを取り出す。テンプレ 1 件・9 行 x 9 セルでなければ失敗する。 */
export function extractGrid(dsl: string): GridExtraction {
  const state = dsl.split('\n').reduce(scanLine, INITIAL)
  if (state.failure !== null) return { ok: false, message: state.failure }
  if (state.sections === 0) return { ok: false, message: '"=== name:" のセクションが無い' }
  if (state.rows.length !== 9) {
    return { ok: false, message: `グリッドが 9 行ではない (${state.rows.length} 行)` }
  }
  return { ok: true, grid: { rows: state.rows } }
}

/** 1 セル分の書き換え指示。row / col は 0 始まり。 */
export type CellEdit = {
  readonly row: number
  readonly col: number
  readonly token: string
}

/**
 * グリッド 1 セルのトークンだけを差し替えた本文を返す。row / col は 0 始まりで、
 * row が段 (上から)、col が筋 (左から = 9 筋から)。抽出できなければ null。
 */
export function replaceCellToken(
  dsl: string,
  row: number,
  col: number,
  token: string,
): string | null {
  return replaceCellTokens(dsl, [{ row, col, token }])
}

/**
 * 複数セルを 1 度に差し替えた本文を返す (矩形塗り)。
 *
 * 1 升ずつ replaceCellToken を重ねると、書き換えるたびにトークンの長さが変わって
 * 同じ行の右側のセルの範囲が古くなる。抽出は 1 度だけにして、行の中は**右から左へ**
 * 当てることで桁のずれを避ける。
 *
 * 同じ升への指示が 2 つあれば後勝ち。範囲外の升が 1 つでも混じっていれば null。
 */
export function replaceCellTokens(dsl: string, edits: readonly CellEdit[]): string | null {
  const extraction = extractGrid(dsl)
  if (!extraction.ok) return null

  const lines = dsl.split('\n')
  const byLine = new Map<number, CellSpan[]>()
  for (const edit of edits) {
    const gridRow = extraction.grid.rows[edit.row]
    const cell = gridRow?.cells[edit.col]
    if (gridRow === undefined || cell === undefined) return null
    if (lines[gridRow.lineIndex] === undefined) return null
    const spans = byLine.get(gridRow.lineIndex) ?? []
    byLine.set(gridRow.lineIndex, [
      ...spans.filter((span) => span.start !== cell.start),
      { token: edit.token, start: cell.start, end: cell.end },
    ])
  }

  return lines
    .map((line, index) => {
      const spans = byLine.get(index)
      if (spans === undefined) return line
      return [...spans]
        .sort((a, b) => b.start - a.start)
        .reduce((text, span) => text.slice(0, span.start) + span.token + text.slice(span.end), line)
    })
    .join('\n')
}
