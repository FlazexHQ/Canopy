import { describe, expect, it } from "vitest"
import { hashApiKey } from "../src/api-keys.ts"
import { hmacSha256, sha256 } from "../src/crypto.ts"

describe("runtime crypto", () => {
  it("matches the NIST SHA-256 vector in both text and byte form", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    expect(sha256("abc").toString("hex")).toBe(expected)
    expect(sha256(Uint8Array.of(0, 97, 98, 99, 0).subarray(1, 4)).toString("hex")).toBe(expected)
    expect(hashApiKey("abc")).toBe(`sha256:${expected}`)
  })

  it("matches RFC 4231 HMAC SHA-256 test cases 1 and 2", () => {
    expect(hmacSha256(new Uint8Array(20).fill(0x0b), "Hi There").toString("hex")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    )
    expect(hmacSha256("Jefe", Buffer.from("what do ya want for nothing?")).toString("hex")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    )
  })
})
