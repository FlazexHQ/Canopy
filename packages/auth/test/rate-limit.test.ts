import { ErrorCode, ForbiddenError, RateLimitError, UnauthorizedError } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import { RateLimits, retryAfterSeconds, TokenBuckets } from "../src/index.ts"

function clock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("TokenBuckets", () => {
  it("lets a burst through, then refuses with the exact wait for the next token", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 2, burst: 3 }, { now: time.now })
    expect([buckets.take("a"), buckets.take("a"), buckets.take("a")]).toEqual([0, 0, 0])
    expect(buckets.take("a")).toBe(500)
    time.advance(499)
    expect(buckets.take("a")).toBe(1)
    time.advance(1)
    expect(buckets.take("a")).toBe(0)
    expect(buckets.take("a")).toBe(500)
  })

  it("refills continuously but never beyond the burst", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 10, burst: 2 }, { now: time.now })
    buckets.take("a")
    buckets.take("a")
    expect(buckets.take("a")).toBe(100)
    time.advance(60_000)
    expect([buckets.take("a"), buckets.take("a"), buckets.take("a")]).toEqual([0, 0, 100])
  })

  it("keeps keys apart", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 1, burst: 1 }, { now: time.now })
    expect(buckets.take("a")).toBe(0)
    expect(buckets.take("a")).toBe(1000)
    expect(buckets.take("b")).toBe(0)
  })

  it("does not spend tokens on a refused request", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 1, burst: 1 }, { now: time.now })
    buckets.take("a")
    for (let i = 0; i < 20; i++) buckets.take("a")
    time.advance(1000)
    expect(buckets.take("a")).toBe(0)
  })

  it("charges a cost above one", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 1, burst: 5 }, { now: time.now })
    expect(buckets.take("a", 4)).toBe(0)
    expect(buckets.take("a", 4)).toBe(3000)
  })

  it("bounds the number of keys, dropping idle full buckets before the least recent one", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 1, burst: 1 }, { now: time.now, maxKeys: 3 })
    buckets.take("a")
    buckets.take("b")
    buckets.take("c")
    expect(buckets.size).toBe(3)
    time.advance(5000)
    buckets.take("d")
    expect(buckets.size).toBe(1)
    buckets.take("e")
    buckets.take("f")
    buckets.take("g")
    expect(buckets.size).toBe(3)
    expect(buckets.take("g")).toBeGreaterThan(0)
  })
})

describe("RateLimits", () => {
  const options = (time: ReturnType<typeof clock>) => ({
    requests: { perSecond: 1, burst: 2 },
    messages: { perSecond: 1, burst: 1 },
    anonymousConnectionsPerAddress: 2,
    now: time.now,
  })
  const user = (sub: string, address = "203.0.113.1") => ({
    key: "pk_live",
    subject: sub,
    roles: new Set(["authenticated"]),
    address,
  })

  it("keys signed in callers by key and subject, whatever their address", () => {
    const limits = new RateLimits(options(clock()))
    expect(limits.request(user("u1", "198.51.100.1"))).toBe(0)
    expect(limits.request(user("u1", "198.51.100.2"))).toBe(0)
    expect(limits.request(user("u1", "198.51.100.3"))).toBeGreaterThan(0)
    expect(limits.request(user("u2"))).toBe(0)
    expect(limits.request({ ...user("u1"), key: "pk_other" })).toBe(0)
  })

  it("keys anonymous callers by address too, since they share one key", () => {
    const limits = new RateLimits(options(clock()))
    const anon = (address: string) => ({
      key: "pk_live",
      subject: "anon",
      roles: new Set(["anon"]),
      address,
    })
    expect(limits.request(anon("198.51.100.1"))).toBe(0)
    expect(limits.request(anon("198.51.100.1"))).toBe(0)
    expect(limits.request(anon("198.51.100.1"))).toBeGreaterThan(0)
    expect(limits.request(anon("198.51.100.2"))).toBe(0)
  })

  it("budgets requests and messages separately", () => {
    const limits = new RateLimits(options(clock()))
    expect(limits.message(user("u1"))).toBe(0)
    expect(limits.message(user("u1"))).toBeGreaterThan(0)
    expect(limits.request(user("u1"))).toBe(0)
  })

  it("exempts the service role unless told not to", () => {
    const service = { key: "sk", subject: "service", roles: new Set(["service"]), address: "x" }
    const limits = new RateLimits(options(clock()))
    for (let i = 0; i < 50; i++) expect(limits.request(service)).toBe(0)
    const strict = new RateLimits({ ...options(clock()), exemptService: false })
    expect(strict.request(service)).toBe(0)
    expect(strict.request(service)).toBe(0)
    expect(strict.request(service)).toBeGreaterThan(0)
  })

  it("caps anonymous connections per address and gives room back once", () => {
    const limits = new RateLimits(options(clock()))
    const first = limits.openAnonymousConnection("198.51.100.1")
    const second = limits.openAnonymousConnection("198.51.100.1")
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(limits.openAnonymousConnection("198.51.100.1")).toBeUndefined()
    expect(limits.openAnonymousConnection("198.51.100.2")).toBeDefined()
    first?.()
    first?.()
    expect(limits.openAnonymousConnection("198.51.100.1")).toBeDefined()
    expect(limits.openAnonymousConnection("198.51.100.1")).toBeUndefined()
  })

  it("resolves the address through trusted proxies only", () => {
    const limits = new RateLimits({ ...options(clock()), trustedProxies: ["10.0.0.0/8"] })
    const headers = new Headers({ "x-forwarded-for": "198.51.100.9" })
    expect(limits.addressOf(headers, "10.1.2.3")).toBe("198.51.100.9")
    expect(limits.addressOf(headers, "192.0.2.5")).toBe("192.0.2.5")
    expect(limits.addressOf(headers, undefined)).toBe("unknown")
  })
})

describe("RateLimits failed authentications", () => {
  const limits = (time: ReturnType<typeof clock>) =>
    new RateLimits({
      requests: { perSecond: 1, burst: 1 },
      messages: { perSecond: 1, burst: 1 },
      anonymousConnectionsPerAddress: 1,
      failedAuthentications: { perSecond: 1, burst: 2 },
      now: time.now,
    })
  const unauthorized = () => Promise.reject(new UnauthorizedError("Invalid API key"))

  it("counts unauthorized attempts per address and blocks before calling the authenticator", async () => {
    const time = clock()
    const guard = limits(time)
    await expect(guard.guardAuthentication("a", unauthorized)).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
    await expect(guard.guardAuthentication("a", unauthorized)).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
    let called = false
    const error = await guard
      .guardAuthentication("a", async () => {
        called = true
        return "principal"
      })
      .catch((e: unknown) => e)
    expect(called).toBe(false)
    expect(error).toBeInstanceOf(RateLimitError)
    expect(error).toMatchObject({ code: ErrorCode.RateLimited, details: { retryAfterSeconds: 1 } })
    expect(guard.authenticationBlocked("a")).toBe(1000)
    await expect(guard.guardAuthentication("b", async () => "principal")).resolves.toBe("principal")
    time.advance(1000)
    await expect(guard.guardAuthentication("a", async () => "principal")).resolves.toBe("principal")
  })

  it("does not count expired tokens, other errors or successes", async () => {
    const guard = limits(clock())
    for (let i = 0; i < 5; i++) {
      await expect(
        guard.guardAuthentication("a", () =>
          Promise.reject(new UnauthorizedError("Token expired", {}, true)),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.TokenExpired })
      await expect(
        guard.guardAuthentication("a", () => Promise.reject(new ForbiddenError("Banned"))),
      ).rejects.toBeInstanceOf(ForbiddenError)
      await guard.guardAuthentication("a", async () => "principal")
    }
    expect(guard.authenticationBlocked("a")).toBe(0)
  })

  it("peeks without spending", () => {
    const time = clock()
    const buckets = new TokenBuckets({ perSecond: 2, burst: 1 }, { now: time.now })
    expect(buckets.peek("a")).toBe(0)
    expect(buckets.take("a")).toBe(0)
    expect(buckets.peek("a")).toBe(500)
    expect(buckets.peek("a")).toBe(500)
    time.advance(500)
    expect(buckets.peek("a")).toBe(0)
    expect(buckets.take("a")).toBe(0)
  })
})

describe("retryAfterSeconds", () => {
  it("rounds up to whole seconds, at least one", () => {
    expect(retryAfterSeconds(1)).toBe(1)
    expect(retryAfterSeconds(1000)).toBe(1)
    expect(retryAfterSeconds(1001)).toBe(2)
  })
})
