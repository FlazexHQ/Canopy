import { brotliCompressSync, constants } from "node:zlib"

/** Measures the optimized client module at Brotli quality 11. */
export function measureClientSize(wasm: Uint8Array): number {
  return brotliCompressSync(wasm, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength
}
