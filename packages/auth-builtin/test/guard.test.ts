import { describe, expect, it } from "vitest"
import { resolveClientAddress } from "../src/index.ts"

const forwarded = (value: string): Headers => new Headers({ "x-forwarded-for": value })

describe("resolveClientAddress", () => {
  it("uses the socket peer and ignores forwarded headers from untrusted peers", () => {
    expect(resolveClientAddress(forwarded("1.2.3.4"), "203.0.113.9", ["127.0.0.1"])).toBe(
      "203.0.113.9",
    )
    expect(resolveClientAddress(new Headers(), undefined, [])).toBe("unknown")
  })

  it("takes the rightmost untrusted hop behind trusted proxies", () => {
    expect(
      resolveClientAddress(forwarded("6.6.6.6, 1.2.3.4, 10.0.0.2"), "10.0.0.1", ["10.0.0.0/8"]),
    ).toBe("1.2.3.4")
    expect(resolveClientAddress(forwarded("1.2.3.4"), "::ffff:127.0.0.1", ["127.0.0.1"])).toBe(
      "1.2.3.4",
    )
    expect(resolveClientAddress(new Headers(), "127.0.0.1", ["127.0.0.1"])).toBe("127.0.0.1")
  })

  it("matches IPv4 CIDR ranges exactly at their edges", () => {
    expect(resolveClientAddress(forwarded("1.1.1.1"), "192.168.1.255", ["192.168.1.0/24"])).toBe(
      "1.1.1.1",
    )
    expect(resolveClientAddress(forwarded("1.1.1.1"), "192.168.2.0", ["192.168.1.0/24"])).toBe(
      "192.168.2.0",
    )
    expect(resolveClientAddress(forwarded("1.1.1.1"), "192.168.2.0", ["192.168.1.0/33"])).toBe(
      "192.168.2.0",
    )
  })
})
