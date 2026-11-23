import { readFile, writeFile } from "node:fs/promises"
import {
  type BucketSpec,
  RateLimits,
  rateLimitError,
  retryAfterSeconds,
  TokenBuckets,
} from "../../../src/rate-limit.ts"

const SEED = 20261123
const BUCKET_CASES = 120
const LIMIT_CASES = 80

/** A small deterministic generator (mulberry32), so the recorded sequences never change between runs. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SPECS: readonly BucketSpec[] = [
  { perSecond: 1, burst: 1 },
  { perSecond: 2, burst: 5 },
  { perSecond: 0.5, burst: 3 },
  { perSecond: 50, burst: 200 },
  { perSecond: 3, burst: 2.5 },
  { perSecond: 1, burst: 30 },
  { perSecond: 0.01, burst: 2 },
]

type BucketOp = readonly ["take" | "peek", number, string, number]
type LimitOp =
  | readonly ["request", number, string | null, string, readonly string[], string]
  | readonly ["blocked" | "failed", number, string]

function bucketCase(next: () => number, index: number) {
  const spec = SPECS[index % SPECS.length] as BucketSpec
  const maxKeys = 1 + Math.floor(next() * 4)
  const keys = ["a", "b", "c", "d", "e"].slice(0, 2 + Math.floor(next() * 4))
  let at = 1_700_000_000_000 + Math.floor(next() * 1000)
  const ops: BucketOp[] = []
  for (let step = 0; step < 40; step += 1) {
    at += [0, 0, 1, 7, 100, 499, 500, 1000, 2500, 60_000][Math.floor(next() * 10)] as number
    if (next() < 0.05) at -= 50
    const key = keys[Math.floor(next() * keys.length)] as string
    const cost = [1, 1, 1, 2, 0.5, 3, 250][Math.floor(next() * 7)] as number
    ops.push([next() < 0.75 ? "take" : "peek", at, key, cost])
  }
  let now = 0
  const buckets = new TokenBuckets(spec, { maxKeys, now: () => now })
  const results = ops.map(([op, time, key, cost]) => {
    now = time
    const wait = op === "take" ? buckets.take(key, cost) : buckets.peek(key, cost)
    return [wait, buckets.size]
  })
  return { kind: "buckets", spec, maxKeys, ops, results }
}

function limitCase(next: () => number, index: number) {
  const requests = SPECS[index % SPECS.length] as BucketSpec
  const failedAuthentications = SPECS[(index + 3) % SPECS.length] as BucketSpec
  const exemptService = next() < 0.7
  const callers: readonly (readonly [string | null, string, readonly string[]])[] = [
    [null, "anon", ["anon"]],
    ["pk", "anon", ["anon"]],
    ["pk", "alice", ["authenticated"]],
    ["key_1", "alice", ["authenticated", "editor"]],
    ["sk", "service", ["service"]],
    ["pk", "bob", ["authenticated"]],
  ]
  const addresses = ["10.0.0.1", "10.0.0.2", "unknown", "2001:db8::1"]
  let at = 1_700_000_000_000
  const ops: LimitOp[] = []
  for (let step = 0; step < 40; step += 1) {
    at += [0, 0, 3, 250, 1000, 4000][Math.floor(next() * 6)] as number
    const address = addresses[Math.floor(next() * addresses.length)] as string
    const roll = next()
    if (roll < 0.6) {
      const [key, subject, roles] = callers[
        Math.floor(next() * callers.length)
      ] as (typeof callers)[number]
      ops.push(["request", at, key, subject, roles, address])
    } else if (roll < 0.8) ops.push(["blocked", at, address])
    else ops.push(["failed", at, address])
  }
  let now = 0
  const limits = new RateLimits({
    requests,
    messages: { perSecond: 1, burst: 1 },
    anonymousConnectionsPerAddress: 1,
    failedAuthentications,
    exemptService,
    maxKeys: 3,
    now: () => now,
  })
  const results = ops.map((op) => {
    now = op[1]
    if (op[0] === "request") {
      const [, , key, subject, roles, address] = op
      return limits.request({ key: key ?? undefined, subject, roles: new Set(roles), address })
    }
    if (op[0] === "blocked") return limits.authenticationBlocked(op[2])
    limits.authenticationFailed(op[2])
    return null
  })
  return {
    kind: "limits",
    requests,
    failedAuthentications,
    exemptService,
    maxKeys: 3,
    ops,
    results,
  }
}

function errorCases() {
  return [1, 999, 1000, 1001, 1999, 2000, 2500, 60_000].map((waitMs) => {
    const error = rateLimitError(waitMs)
    return {
      kind: "error",
      waitMs,
      seconds: retryAfterSeconds(waitMs),
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
    }
  })
}

/**
 * Computes `conformance/auth/rate-limits.json`: seeded sequences of operations on the token buckets and the
 * request limits of `@canopy/auth`, on a fake clock, with what each returned, and the rate limit error of
 * several waits. With `check`, compares with the file instead of writing it and returns whether it differs.
 */
export async function recordRateLimits(options: {
  readonly file: string
  readonly check: boolean
}): Promise<boolean> {
  const next = random(SEED)
  const cases = [
    ...Array.from({ length: BUCKET_CASES }, (_, index) => bucketCase(next, index)),
    ...Array.from({ length: LIMIT_CASES }, (_, index) => limitCase(next, index)),
    ...errorCases(),
  ]
  const content = `{"source":${JSON.stringify(`@canopy/auth rate limits, seed ${SEED}, ${cases.length} cases`)},"cases":[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`
  if (options.check) {
    const current = await readFile(options.file, "utf8").catch(() => "")
    return current.replaceAll("\r\n", "\n") !== content
  }
  await writeFile(options.file, content)
  return false
}
