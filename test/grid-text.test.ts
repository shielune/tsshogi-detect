// grid-text の抽出・置換テスト。
//
// 最重要は「全 354 定義について、各セルを自分自身のトークンで置換したら
// 元の本文と 1 文字も変わらない」こと。これが通れば、盤面編集が桁揃えや
// コメントを壊さないことが構造的に保証される。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractGrid, replaceCellToken, replaceCellTokens } from '../src/grid-text.ts'
import { parseTemplateFile } from '../src/parser.ts'

const ASSETS = join(import.meta.dir, '../data')

const GRID9 = Array.from({ length: 9 }, () => '. . . . . . . . .').join('\n')

function withGrid(header: string, grid: string = GRID9): string {
  return `=== name: てすと\n${header}\n${grid}\n`
}

/**
 * txt からテンプレ 1 件分の原文を切り出す (formation-source.ts の sliceSource と同じ)。
 * `category: true` の節は盤を持たない (パーサがグリッド行を禁じている) ので外す。
 */
function sections(file: string): string[] {
  const content = readFileSync(join(ASSETS, file), 'utf8')
  const lines = content.split('\n')
  return parseTemplateFile(content)
    .filter((parsed) => !parsed.category)
    .map(
      (parsed) =>
        `${lines
          .slice(parsed.sourceStartLine - 1, parsed.sourceEndLine)
          .join('\n')
          .trimEnd()}\n`,
    )
}

describe('extractGrid', () => {
  test('ヘッダ無しのグリッドを取り出す', () => {
    const result = extractGrid(withGrid(''))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grid.rows).toHaveLength(9)
    expect(result.grid.rows[0]?.cells).toHaveLength(9)
    expect(result.grid.rows[0]?.lineIndex).toBe(2)
  })

  test('ヘッダ・空行・行内コメントがあっても取り出せる', () => {
    const dsl = [
      '# 先頭コメント',
      '=== name: てすと // 見出しの後ろ',
      'parent: おや',
      'visited: G 6 9',
      '',
      ...Array.from({ length: 8 }, () => '. . . . . . . . .'),
      '. . . . . . . . .  # 最終段',
      '',
    ].join('\n')
    const result = extractGrid(dsl)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grid.rows).toHaveLength(9)
    expect(result.grid.rows[8]?.cells[8]?.token).toBe('.')
  })

  test('行頭インデントがあってもオフセットが合う', () => {
    const indented = Array.from({ length: 9 }, () => '    . . . . . . . . .').join('\n')
    const result = extractGrid(withGrid('', indented))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grid.rows[0]?.cells[0]?.start).toBe(4)
  })

  test.each([
    ['8 行', withGrid('', Array.from({ length: 8 }, () => '. . . . . . . . .').join('\n'))],
    ['10 行', withGrid('', Array.from({ length: 10 }, () => '. . . . . . . . .').join('\n'))],
    [
      'セル 8 個',
      withGrid(
        '',
        ['. . . . . . . .', ...Array.from({ length: 8 }, () => '. . . . . . . . .')].join('\n'),
      ),
    ],
    ['セクション 0 件', GRID9],
    ['セクション 2 件', `${withGrid('')}\n${withGrid('')}`],
  ])('%s は失敗する', (_label, dsl) => {
    expect(extractGrid(dsl).ok).toBe(false)
  })
})

describe('replaceCellToken', () => {
  test('指定セルだけが変わる', () => {
    const dsl = withGrid('')
    const next = replaceCellToken(dsl, 7, 3, 'K')
    expect(next).not.toBeNull()
    expect(next?.split('\n')[9]).toBe('. . . K . . . . .')
    expect(next?.split('\n')[8]).toBe('. . . . . . . . .')
  })

  test('トークンの外側の文字は 1 文字も動かない', () => {
    const dsl = withGrid(
      '',
      ['. .  [GS] . . . . . .', ...Array.from({ length: 8 }, () => '. . . . . . . . .')].join('\n'),
    )
    const next = replaceCellToken(dsl, 0, 2, 'G')
    expect(next?.split('\n')[2]).toBe('. .  G . . . . . .')
  })

  test('範囲外の row / col は null', () => {
    expect(replaceCellToken(withGrid(''), 9, 0, 'K')).toBeNull()
    expect(replaceCellToken(withGrid(''), 0, 9, 'K')).toBeNull()
  })

  test('抽出できない本文は null', () => {
    expect(replaceCellToken(GRID9, 0, 0, 'K')).toBeNull()
  })
})

describe('replaceCellTokens', () => {
  test('同じ行の複数セルを 1 度に書ける (桁がずれない)', () => {
    // 長いトークンを左から順に当てると、右のセルの範囲が古くなって壊れる形
    const next = replaceCellTokens(withGrid(''), [
      { row: 0, col: 0, token: '[GS]' },
      { row: 0, col: 1, token: '[GS]' },
      { row: 0, col: 8, token: '+P' },
    ])
    expect(next?.split('\n')[2]).toBe('[GS] [GS] . . . . . . +P')
  })

  test('複数行にまたがる矩形を書ける', () => {
    const next = replaceCellTokens(withGrid(''), [
      { row: 1, col: 7, token: 'r' },
      { row: 1, col: 8, token: 'r' },
      { row: 2, col: 7, token: 'r' },
      { row: 2, col: 8, token: 'r' },
    ])
    const lines = next?.split('\n') ?? []
    expect(lines[2]).toBe('. . . . . . . . .')
    expect(lines[3]).toBe('. . . . . . . r r')
    expect(lines[4]).toBe('. . . . . . . r r')
  })

  test('トークンの外側の文字は 1 文字も動かない', () => {
    const dsl = withGrid(
      '',
      ['. .  [GS] . . . .   .  .', ...Array.from({ length: 8 }, () => '. . . . . . . . .')].join(
        '\n',
      ),
    )
    const next = replaceCellTokens(dsl, [
      { row: 0, col: 2, token: 'G' },
      { row: 0, col: 7, token: 'S' },
    ])
    expect(next?.split('\n')[2]).toBe('. .  G . . . .   S  .')
  })

  test('同じ升への指示が 2 つあれば後勝ち', () => {
    const next = replaceCellTokens(withGrid(''), [
      { row: 0, col: 0, token: 'G' },
      { row: 0, col: 0, token: 'S' },
    ])
    expect(next?.split('\n')[2]).toBe('S . . . . . . . .')
  })

  test('範囲外の升が 1 つでも混じれば null (中途半端に書かない)', () => {
    expect(
      replaceCellTokens(withGrid(''), [
        { row: 0, col: 0, token: 'K' },
        { row: 9, col: 0, token: 'K' },
      ]),
    ).toBeNull()
  })

  test('指示が空なら本文はそのまま', () => {
    const dsl = withGrid('')
    expect(replaceCellTokens(dsl, [])).toBe(dsl)
  })
})

describe('全定義ラウンドトリップ', () => {
  test.each(['castles.txt', 'strategies.txt'])('%s の各セルを自分自身で置換しても不変', (file) => {
    const all = sections(file)
    expect(all.length).toBeGreaterThan(100)

    for (const dsl of all) {
      const extraction = extractGrid(dsl)
      expect(extraction.ok).toBe(true)
      if (!extraction.ok) continue

      const rebuilt = extraction.grid.rows.reduce(
        (text, row, rowIdx) =>
          row.cells.reduce(
            (inner, cell, colIdx) => replaceCellToken(inner, rowIdx, colIdx, cell.token) ?? inner,
            text,
          ),
        dsl,
      )
      expect(rebuilt).toBe(dsl)
    }
  })
})
