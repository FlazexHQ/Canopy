import { describe, expect, it } from "vitest"
import { addressMatches, isAddressRule, resolveClientAddress } from "../src/index.ts"

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

  it("ignores forwarded hops from untrusted peers and falls back to the peer when every hop is a proxy", () => {
    expect(resolveClientAddress(forwarded("10.0.0.5"), "10.0.0.1", ["10.0.0.0/8"])).toBe("10.0.0.1")
    expect(
      resolveClientAddress(forwarded("127.0.0.1, 10.0.0.9"), "198.51.100.4", ["10.0.0.0/8"]),
    ).toBe("198.51.100.4")
    expect(resolveClientAddress(forwarded(""), "10.0.0.1", ["10.0.0.0/8"])).toBe("10.0.0.1")
  })

  it("trusts IPv6 proxies by address and range", () => {
    expect(resolveClientAddress(forwarded("2001:db8::7"), "::1", ["::1"])).toBe("2001:db8::7")
    expect(resolveClientAddress(forwarded("203.0.113.5"), "fd00::2", ["fd00::/8"])).toBe(
      "203.0.113.5",
    )
    expect(resolveClientAddress(forwarded("203.0.113.5"), "fe00::2", ["fd00::/8"])).toBe("fe00::2")
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

describe("addressMatches", () => {
  it("compares parsed addresses, not text", () => {
    expect(addressMatches("0:0:0:0:0:0:0:1", ["::1"])).toBe(true)
    expect(addressMatches("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true)
    expect(addressMatches("10.1.2.3", ["::ffff:10.1.2.3"])).toBe(true)
    expect(addressMatches("127.0.0.1", ["::1"])).toBe(false)
    expect(addressMatches("not an address", ["0.0.0.0/0", "::/0"])).toBe(false)
    expect(addressMatches("1.2.3.4", ["garbage", "1.2.3.0/24"])).toBe(true)
  })

  it("validates rules", () => {
    expect(isAddressRule("10.0.0.0/8")).toBe(true)
    expect(isAddressRule("2001:db8::/32")).toBe(true)
    expect(isAddressRule("10.0.0.0/33")).toBe(false)
    expect(isAddressRule("example.com")).toBe(false)
  })
})
