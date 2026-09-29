/**
 * `tsshogi-detect/wasm` — recordDefinitions / recordDefinitionsWithDropped と同じ結果を
 * WASM の走査器で返す入口。
 *
 * ```ts
 * const scanner = await loadScanner()
 * const compiled = scanner.compile(definitions) // 扱えない定義なら UnsupportedDefinitionError
 * const detections = compiled.recordMany(games, { moverOnly: true, requireParent: true })
 * compiled.release()
 * ```
 *
 * 平手から始まる棋譜だけを扱う。返す `definition` は compile に渡したオブジェクトそのもの。
 */

import { SCANNER_WASM_BASE64 } from './scanner.gen.ts'
import { instantiateScanner, type WasmScanner } from './scanner.ts'

export { UnsupportedDefinitionError } from './encode.ts'
export {
  CompiledScan,
  WasmScanner,
  type WasmScanOptions,
  type WasmScanWithDropped,
} from './scanner.ts'

let loading: Promise<WasmScanner> | undefined

/**
 * 同梱の WASM から走査器を組む。2 回目以降は同じものを返す。
 * ブラウザの主スレッドでは 4KB を超える同期コンパイルが断られるので、非同期で組む。
 */
export function loadScanner(): Promise<WasmScanner> {
  loading ??= instantiateScanner(decodeBase64(SCANNER_WASM_BASE64)).catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let k = 0; k < binary.length; k += 1) bytes[k] = binary.charCodeAt(k)
  return bytes
}
