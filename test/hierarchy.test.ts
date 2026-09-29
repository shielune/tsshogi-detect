// 親ゲートで裏付けを見る相手 (gateParents)。WASM の走査器へ渡す分を、
// dropUnestablishedChildren が内側で使う gateParent と同じ規則で引けているか確かめる。

import { describe, expect, test } from 'bun:test'
import { PieceType } from 'tsshogi'
import type { FormationDefinition } from '../src/definition.ts'
import { gateParents } from '../src/hierarchy.ts'
import { PiecePlacement } from '../src/requirements.ts'

const shape = (name: string, extra?: Partial<FormationDefinition>): FormationDefinition => ({
  name,
  placements: [new PiecePlacement(5, 9, PieceType.KING)],
  ...extra,
})

const category = (name: string, extra?: Partial<FormationDefinition>): FormationDefinition => ({
  name,
  category: true,
  placements: [],
  ...extra,
})

/** 返った相手を名前で読む。同じ名前が 2 つあるときは添字で見分ける */
const parentNames = (definitions: readonly FormationDefinition[]): (string | undefined)[] =>
  gateParents(definitions).map((parent) => parent?.name)

describe('gateParents', () => {
  test('親が無ければ undefined、あればその定義', () => {
    const definitions = [shape('親'), shape('子', { parent: '親' }), shape('孫', { parent: '子' })]
    expect(parentNames(definitions)).toEqual([undefined, '親', '子'])
    // 返すのは渡した定義そのもの
    expect(gateParents(definitions)[1]).toBe(definitions[0] as FormationDefinition)
  })

  test('間に挟まったカテゴリは素通しして、その先の祖先を見る', () => {
    const definitions = [
      shape('根'),
      category('分類', { parent: '根' }),
      category('小分類', { parent: '分類' }),
      shape('子', { parent: '小分類' }),
      category('宙に浮いた分類'),
      shape('分類だけの子', { parent: '宙に浮いた分類' }),
    ]
    expect(parentNames(definitions)).toEqual([
      undefined,
      '根',
      '根',
      '根',
      undefined,
      undefined,
    ])
  })

  test('別名で書かれた親も引ける。ただし別名は本名を潰さない', () => {
    const definitions = [
      shape('本家', { aliases: ['旧名', '被り'] }),
      shape('被り'),
      shape('子', { parent: '旧名' }),
      shape('被りの子', { parent: '被り' }),
    ]
    const parents = gateParents(definitions)
    expect(parents[2]).toBe(definitions[0] as FormationDefinition)
    expect(parents[3]).toBe(definitions[1] as FormationDefinition)
  })

  test('走査集合に居ない親は undefined', () => {
    expect(parentNames([shape('子', { parent: '居ない' })])).toEqual([undefined])
  })

  test('同じ名前が 2 つあれば後ろの方が索引に残る', () => {
    const first = shape('被り')
    const second = shape('被り', { priority: 1 })
    const child = shape('子', { parent: '被り' })
    expect(gateParents([first, second, child])[2]).toBe(second)
    // 自分自身を親に書いても、自分は辿らない
    expect(parentNames([shape('自分', { parent: '自分' })])).toEqual([undefined])
  })

  test('循環していても止まる', () => {
    const definitions = [shape('甲', { parent: '乙' }), shape('乙', { parent: '甲' })]
    expect(parentNames(definitions)).toEqual(['乙', '甲'])
    const through = [
      category('環', { parent: '輪' }),
      category('輪', { parent: '環' }),
      shape('子', { parent: '環' }),
    ]
    // カテゴリだけの環を一周して、非カテゴリの祖先が見つからない
    expect(parentNames(through)).toEqual([undefined, undefined, undefined])
  })
})
