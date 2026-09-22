// ヘッダ 1 行の差し替え。触っていない行が動かないことまで見る。

import { describe, expect, test } from 'bun:test'
import { readDefinitionName, setHeaderField, setDefinitionName } from '../src/header-text.ts'
import { parseDefinitionFile } from '../src/parser.ts'

const GRID = Array.from({ length: 9 }, () => '. . . . . . . . .').join('\n')

describe('setHeaderField', () => {
  test('既にある行は値だけ差し替える', () => {
    const dsl = `=== name: 美濃囲い\nparent: 片美濃囲い\naliases: ダイヤ\n\n${GRID}\n`
    expect(setHeaderField(dsl, 'parent', '高美濃囲い')).toBe(
      `=== name: 美濃囲い\nparent: 高美濃囲い\naliases: ダイヤ\n\n${GRID}\n`,
    )
  })

  test('無ければ === name: の直後に足す', () => {
    const dsl = `=== name: 片美濃囲い\n\n${GRID}\n`
    expect(setHeaderField(dsl, 'parent', '美濃囲い')).toBe(
      `=== name: 片美濃囲い\nparent: 美濃囲い\n\n${GRID}\n`,
    )
  })

  test('null なら行ごと消す', () => {
    const dsl = `=== name: 美濃囲い\nparent: 片美濃囲い\n\n${GRID}\n`
    expect(setHeaderField(dsl, 'parent', null)).toBe(`=== name: 美濃囲い\n\n${GRID}\n`)
  })

  test('無い行を消しても本文は動かない', () => {
    const dsl = `=== name: 美濃囲い\n\n${GRID}\n`
    expect(setHeaderField(dsl, 'parent', null)).toBe(dsl)
  })

  test('行末コメントは残る', () => {
    const dsl = `=== name: 美濃囲い\nparent: 片美濃囲い  # 系統  \n\n${GRID}\n`
    expect(setHeaderField(dsl, 'parent', '舟囲い')).toBe(
      `=== name: 美濃囲い\nparent: 舟囲い  # 系統  \n\n${GRID}\n`,
    )
  })

  test('書き換えた本文はパースできて、親が変わっている', () => {
    const dsl = `=== name: 美濃囲い\nparent: 片美濃囲い\n\n${GRID}\n`
    const next = setHeaderField(dsl, 'parent', '舟囲い')
    expect(next).not.toBeNull()
    expect(parseDefinitionFile(next ?? '')[0]?.parent).toBe('舟囲い')
  })

  test('セクションが無ければ書けない', () => {
    expect(setHeaderField(`${GRID}\n`, 'parent', '美濃囲い')).toBeNull()
  })

  test('コメント記号や改行の混じる値は書かない', () => {
    const dsl = `=== name: 美濃囲い\n\n${GRID}\n`
    expect(setHeaderField(dsl, 'parent', '美濃 # 囲い')).toBeNull()
    expect(setHeaderField(dsl, 'parent', '美濃\n囲い')).toBeNull()
  })
})

describe('setDefinitionName / readDefinitionName', () => {
  test('名前だけ差し替わり、ヘッダも盤も動かない', () => {
    const dsl = `=== name: 美濃囲い\nparent: 片美濃囲い\n\n${GRID}\n`
    expect(setDefinitionName(dsl, '高美濃囲い')).toBe(
      `=== name: 高美濃囲い\nparent: 片美濃囲い\n\n${GRID}\n`,
    )
  })

  test('行末コメントは残る', () => {
    const dsl = `=== name: 美濃囲い  # 出典  \n\n${GRID}\n`
    expect(setDefinitionName(dsl, '舟囲い')).toBe(`=== name: 舟囲い  # 出典  \n\n${GRID}\n`)
  })

  test('書き換えた本文はパースできて、名前が変わっている', () => {
    const dsl = `=== name: 美濃囲い\n\n${GRID}\n`
    const next = setDefinitionName(dsl, '舟囲い')
    expect(next).not.toBeNull()
    expect(parseDefinitionFile(next ?? '')[0]?.name).toBe('舟囲い')
  })

  test('読み出しは編集の途中 (盤が壊れている) でも効く', () => {
    expect(readDefinitionName('=== name: 新しい定義\n. . .\n')).toBe('新しい定義')
    expect(readDefinitionName(`=== name: 美濃囲い  // 別名あり\n\n${GRID}\n`)).toBe('美濃囲い')
  })

  test('セクションが無い / 書けない値は null', () => {
    expect(setDefinitionName(`${GRID}\n`, '美濃囲い')).toBeNull()
    expect(readDefinitionName(`${GRID}\n`)).toBeNull()
    expect(setDefinitionName(`=== name: 美濃囲い\n\n${GRID}\n`, '美濃 # 囲い')).toBeNull()
  })
})
