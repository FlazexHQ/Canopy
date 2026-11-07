import { describe, expect, it } from "vitest"
import { addressAllowed, isAddressRule } from "../src/index.ts"

describe("admin IP allowlist", () => {
  it("allows everyone with an empty list and refuses unknown addresses otherwise", () => {
    expect(addressAllowed(undefined, [])).toBe(true)
    expect(addressAllowed("198.51.100.1", [])).toBe(true)
    expect(addressAllowed(undefined, ["0.0.0.0/0"])).toBe(false)
    expect(addressAllowed("not an address", ["0.0.0.0/0"])).toBe(false)
  })

  it("matches IPv4 addresses and CIDR ranges, including IPv4 mapped IPv6", () => {
    const rules = ["10.0.0.0/8", "192.168.1.7", "172.16.0.0/12"]
    expect(addressAllowed("10.255.3.4", rules)).toBe(true)
    expect(addressAllowed("11.0.0.1", rules)).toBe(false)
    expect(addressAllowed("192.168.1.7", rules)).toBe(true)
    expect(addressAllowed("192.168.1.8", rules)).toBe(false)
    expect(addressAllowed("172.31.255.255", rules)).toBe(true)
    expect(addressAllowed("172.32.0.0", rules)).toBe(false)
    expect(addressAllowed("::ffff:10.1.2.3", rules)).toBe(true)
    expect(addressAllowed("::ffff:11.1.2.3", rules)).toBe(false)
    expect(addressAllowed("1.2.3.4", ["0.0.0.0/0"])).toBe(true)
  })

  it("matches IPv6 addresses and ranges without mixing families", () => {
    const rules = ["2001:db8::/32", "::1", "fe80::1%eth0"]
    expect(addressAllowed("2001:db8:ffff::1", rules)).toBe(true)
    expect(addressAllowed("2001:db9::1", rules)).toBe(false)
    expect(addressAllowed("::1", rules)).toBe(true)
    expect(addressAllowed("[::1]", rules)).toBe(true)
    expect(addressAllowed("0:0:0:0:0:0:0:1", rules)).toBe(true)
    expect(addressAllowed("::2", rules)).toBe(false)
    expect(addressAllowed("fe80::1", rules)).toBe(true)
    expect(addressAllowed("127.0.0.1", ["::1"])).toBe(false)
    expect(addressAllowed("::1", ["127.0.0.1"])).toBe(false)
    expect(addressAllowed("2001:db8::7", ["2001:db8::7/128"])).toBe(true)
    expect(addressAllowed("2001:db8::8", ["2001:db8::7/128"])).toBe(false)
  })

  it("validates rules", () => {
    for (const rule of ["10.0.0.0/8", "1.2.3.4", "::/0", "2001:db8::/32", "::ffff:1.2.3.4"])
      expect(isAddressRule(rule)).toBe(true)
    for (const rule of [
      "10.0.0.0/33",
      "2001:db8::/129",
      "256.1.1.1",
      "1.2.3",
      "example.com",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "10.0.0.0/x",
      "",
    ])
      expect(isAddressRule(rule)).toBe(false)
  })
})
