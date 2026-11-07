import { describe, expect, it } from "vitest"
import { RevocationSet } from "../src/index.ts"

const T0 = Date.UTC(2026, 10, 7, 12, 0, 0)

function clock(start = T0): { now: () => number; advance(ms: number): void } {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
  }
}

describe("RevocationSet", () => {
  it("refuses every token issued at or before a revocation of everyone, until it expires", () => {
    const time = clock()
    const set = new RevocationSet({ now: time.now })
    set.add({ kind: "all", sub: "*", at: new Date(T0), expiresAt: new Date(T0 + 600_000) })
    expect(set.has({ sub: "u1", iat: T0 / 1000 })).toBe(true)
    expect(set.has({ sub: "u2", sid: "s9", iat: T0 / 1000 - 60 })).toBe(true)
    expect(set.has({ iat: T0 / 1000 - 1 })).toBe(true)
    expect(set.has({ sub: "u1" })).toBe(true)
    expect(set.has({ sub: "u1", iat: T0 / 1000 + 1 })).toBe(false)
    expect(set.size).toBe(1)
    time.advance(600_000)
    expect(set.has({ sub: "u1", iat: T0 / 1000 })).toBe(false)
    set.prune()
    expect(set.size).toBe(0)
  })

  it("refuses tokens of a revoked session, whatever their issue time", () => {
    const time = clock()
    const set = new RevocationSet({ now: time.now })
    set.add({
      kind: "session",
      sub: "u1",
      sid: "s1",
      at: new Date(T0),
      expiresAt: new Date(T0 + 600_000),
    })
    expect(set.has({ sub: "u1", sid: "s1", iat: T0 / 1000 + 30 })).toBe(true)
    expect(set.has({ sub: "u1", sid: "s2", iat: T0 / 1000 - 30 })).toBe(false)
    expect(set.has({ sub: "u2", sid: "s1" })).toBe(true)
  })

  it("refuses user tokens issued at or before the revocation and accepts later ones", () => {
    const time = clock()
    const set = new RevocationSet({ now: time.now })
    set.add({ kind: "user", sub: "u1", at: new Date(T0), expiresAt: new Date(T0 + 600_000) })
    expect(set.has({ sub: "u1", iat: T0 / 1000 - 1 })).toBe(true)
    expect(set.has({ sub: "u1", iat: T0 / 1000 })).toBe(true)
    expect(set.has({ sub: "u1", iat: T0 / 1000 + 1 })).toBe(false)
    expect(set.has({ sub: "u1" })).toBe(true)
    expect(set.has({ sub: "u2", iat: T0 / 1000 - 1 })).toBe(false)
  })

  it("keeps the latest user revocation when two arrive out of order", () => {
    const set = new RevocationSet({ now: clock().now })
    set.add({ kind: "user", sub: "u1", at: new Date(T0 + 5000), expiresAt: new Date(T0 + 600_000) })
    set.add({ kind: "user", sub: "u1", at: new Date(T0), expiresAt: new Date(T0 + 300_000) })
    expect(set.has({ sub: "u1", iat: T0 / 1000 + 4 })).toBe(true)
    expect(set.has({ sub: "u1", iat: T0 / 1000 + 6 })).toBe(false)
  })

  it("forgets revocations once they expire and ignores ones that already have", () => {
    const time = clock()
    const set = new RevocationSet({ now: time.now })
    set.add({
      kind: "session",
      sub: "u1",
      sid: "s1",
      at: new Date(T0),
      expiresAt: new Date(T0 + 1000),
    })
    set.add({
      kind: "session",
      sub: "u1",
      sid: "old",
      at: new Date(T0 - 5000),
      expiresAt: new Date(T0 - 1),
    })
    set.add({ kind: "session", sub: "u1", at: new Date(T0), expiresAt: new Date(T0 + 1000) })
    expect(set.size).toBe(1)
    expect(set.has({ sub: "u1", sid: "old" })).toBe(false)
    time.advance(1000)
    expect(set.has({ sub: "u1", sid: "s1" })).toBe(false)
    set.prune()
    expect(set.size).toBe(0)
  })
})
