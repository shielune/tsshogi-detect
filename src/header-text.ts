// DSL 本文のヘッダ行 (`parent:` `side:` `ply:` …) を 1 行だけ書き換えるユーティリティ。
//
// grid-text.ts が盤の 1 セルだけを差し替えるのと同じ趣旨で、こちらはヘッダ 1 行だけを
// 差し替える。触っていない行は 1 文字も動かないので、textarea が全行 diff にならない。
//
// ヘッダの位置づけは parser.ts に合わせる: `=== name:` の直後からグリッドの手前までが
// ヘッダ領域で、`key: value` の形。行末コメント (`#` / `//`) は残す。

import { stripComments } from './parser.ts'

/** ヘッダ領域の 1 行。index は dsl.split('\n') の添字 (0 始まり)。 */
export type HeaderLine = {
  readonly index: number
  readonly key: string
  /** コメントと前後の空白を落とした値。書き戻しは writeHeaderLine が行の中で行う。 */
  readonly value: string
}

/** ヘッダ領域の走査結果。 */
type HeaderScan = {
  /** `=== name:` の行。見つからなければ null。 */
  readonly nameLine: number | null
  /** `=== name:` の直後からグリッドの手前までの `key: value` 行。 */
  readonly headers: readonly HeaderLine[]
}

function scanHeader(lines: readonly string[]): HeaderScan {
  let nameLine: number | null = null
  const headers: HeaderLine[] = []
  for (const [index, raw] of lines.entries()) {
    const stripped = stripComments(raw).trim()
    if (stripped === '') continue
    if (stripped.startsWith('===')) {
      // 2 件目のセクションに入ったらヘッダ領域は終わり (エディタは 1 件しか扱わない)
      if (nameLine !== null) break
      nameLine = index
      continue
    }
    if (nameLine === null) continue
    // ヘッダはグリッドより前にしか現れない。`key: value` でない行が出たらそこで終わり
    const colon = stripped.indexOf(':')
    if (colon < 0) break
    headers.push({
      index,
      key: stripped.slice(0, colon).trim(),
      value: stripped.slice(colon + 1).trim(),
    })
  }
  return { nameLine, headers }
}

/**
 * ヘッダ領域にある `key:` の行を上から順に返す。
 *
 * setHeaderField が触るのは常にこの先頭 1 行だが、`visited:` のように同じ鍵を
 * 何行も書ける要件があるので、行を選んで消したい側にはすべて渡す。
 */
export function headerLines(dsl: string, key: string): readonly HeaderLine[] {
  return scanHeader(dsl.split('\n')).headers.filter((header) => header.key === key)
}

const NAME_LINE = /^\s*===\s*name\s*:\s*/

/**
 * `=== name:` 行と、その行の中の値の範囲。名前だけはヘッダの `key: value` ではなく
 * セクションの開始行に載っているので、setHeaderField とは別に扱う。
 */
function nameSpan(
  lines: readonly string[],
): { readonly line: number; readonly start: number; readonly end: number } | null {
  const line = lines.findIndex((raw) => stripComments(raw).trim().startsWith('==='))
  const text = lines[line]
  if (text === undefined) return null
  const match = text.match(NAME_LINE)
  if (match === null) return null
  const start = match[0].length
  const comment = text.search(/#|\/\//)
  const limit = comment < 0 || comment < start ? text.length : comment
  // 行末コメントは値に含めない (setHeaderField と同じ扱い)
  return { line, start, end: start + text.slice(start, limit).trimEnd().length }
}

/** `=== name:` の値。セクションが無ければ null。パースを通さないので編集の途中でも読める。 */
export function readTemplateName(dsl: string): string | null {
  const lines = dsl.split('\n')
  const span = nameSpan(lines)
  return span === null ? null : (lines[span.line]?.slice(span.start, span.end) ?? null)
}

/**
 * `=== name:` の値だけを差し替えた本文を返す。行末コメントもヘッダも動かない。
 * セクションが無い / 値に改行やコメント記号が混じるときは null。
 */
export function setTemplateName(dsl: string, name: string): string | null {
  if (name.includes('\n') || name.includes('#') || name.includes('//')) return null
  const lines = dsl.split('\n')
  const span = nameSpan(lines)
  const text = span === null ? undefined : lines[span.line]
  if (span === null || text === undefined) return null
  const replaced = text.slice(0, span.start) + name + text.slice(span.end)
  return lines.map((line, index) => (index === span.line ? replaced : line)).join('\n')
}

/** 行の `key:` の後ろ (値の始まり) と、行末コメントの始まりを返す。 */
function valueSpan(line: string, key: string): { start: number; end: number } | null {
  const match = line.match(new RegExp(`^(\\s*${key}\\s*:\\s*)`))
  if (match === null) return null
  const start = match[0].length
  const comment = line.search(/#|\/\//)
  const limit = comment < 0 || comment < start ? line.length : comment
  // 値の末尾の空白は値に含めない。コメントとの間合いをそのまま残すため
  return { start, end: start + line.slice(start, limit).trimEnd().length }
}

/** 値に改行やコメント記号が混じっていないか。混じると行の意味が変わるので書かない。 */
const writableValue = (value: string): boolean =>
  !value.includes('\n') && !value.includes('#') && !value.includes('//')

/**
 * ヘッダ行 1 本を書き換えた本文を返す。value が null ならその行ごと消す。
 *
 * 行は添字で指すので、`visited:` のように**同じ鍵が何行もある**ヘッダでも狙って書ける
 * (鍵で引く setHeaderField は常に先頭の 1 行しか触らない)。行末コメントは残る。
 */
export function writeHeaderLine(
  dsl: string,
  index: number,
  key: string,
  value: string | null,
): string | null {
  const lines = dsl.split('\n')
  if (value === null) return lines.filter((_line, other) => other !== index).join('\n')
  if (!writableValue(value)) return null
  const line = lines[index]
  if (line === undefined) return null
  const span = valueSpan(line, key)
  if (span === null) return null
  const replaced = line.slice(0, span.start) + value + line.slice(span.end)
  return lines.map((text, other) => (other === index ? replaced : text)).join('\n')
}

/**
 * ヘッダ行を 1 本足した本文を返す。同じ鍵の行があればその最後の次に、無ければ
 * `=== name:` の直後へ置く (パーサはヘッダの順序を見ないので、読みやすさだけの話)。
 */
export function insertHeaderLine(dsl: string, key: string, value: string): string | null {
  if (!writableValue(value)) return null
  const lines = dsl.split('\n')
  const { nameLine, headers } = scanHeader(lines)
  if (nameLine === null) return null
  const last = headers.filter((header) => header.key === key).at(-1)
  const after = (last?.index ?? nameLine) + 1
  return [...lines.slice(0, after), `${key}: ${value}`, ...lines.slice(after)].join('\n')
}

/**
 * ヘッダ 1 行を書き換えた本文を返す。value が null ならその行ごと消す。
 *
 * - 既にある行は**値の部分だけ**差し替える (行末コメントは残る)
 * - 無ければ `=== name:` の直後に挿入する (ヘッダの順序はパーサが見ていない)
 * - セクションが無い / 値に改行やコメント記号が混じるなど、安全に書けないときは null
 */
export function setHeaderField(dsl: string, key: string, value: string | null): string | null {
  const { nameLine, headers } = scanHeader(dsl.split('\n'))
  if (nameLine === null) return null
  const first = headers.find((header) => header.key === key)
  if (first === undefined) {
    return value === null ? dsl : insertHeaderLine(dsl, key, value)
  }
  return writeHeaderLine(dsl, first.index, key, value)
}
