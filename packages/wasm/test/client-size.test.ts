import { brotliCompressSync, constants } from "node:zlib"
import { expect, it } from "vitest"
import { measureClientSize } from "../scripts/client-size.ts"

it("measures the binary input compressed at Brotli quality 11", () => {
  const wasm = Uint8Array.from({ length: 4096 }, (_, index) => (index ** 2 + index) % 256)
  const expected = brotliCompressSync(wasm, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength
  expect(measureClientSize(wasm)).toBe(expected)
})
