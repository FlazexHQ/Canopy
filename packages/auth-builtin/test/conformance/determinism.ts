import { createECDH, createHash, createPrivateKey, type webcrypto } from "node:crypto"

/** The instant every case starts at: 2031-01-01T00:00:00.000Z. */
export const EPOCH = Date.UTC(2031, 0, 1)

/** A clock that only moves when told to. */
export class FakeClock {
  private current = EPOCH

  now(): number {
    return this.current
  }

  set(ms: number): void {
    this.current = ms
  }

  advance(ms: number): void {
    this.current += ms
  }

  iso(): string {
    return new RealDate(this.current).toISOString()
  }
}

/** Bytes from SHA-256 in counter mode over a seed: the same seed always yields the same stream. */
export class SeededRandom {
  private seed = Buffer.alloc(0)
  private counter = 0
  private pool = Buffer.alloc(0)

  reseed(seed: string): void {
    this.seed = createHash("sha256").update(seed).digest()
    this.counter = 0
    this.pool = Buffer.alloc(0)
  }

  bytes(length: number): Buffer {
    while (this.pool.length < length) {
      const block = Buffer.alloc(4)
      block.writeUInt32BE(this.counter++)
      this.pool = Buffer.concat([
        this.pool,
        createHash("sha256").update(this.seed).update(block).digest(),
      ])
    }
    const out = this.pool.subarray(0, length)
    this.pool = this.pool.subarray(length)
    return Buffer.from(out)
  }
}

const RealDate = Date
const realFetch = globalThis.fetch
const webCrypto = globalThis.crypto
const subtle = webCrypto.subtle
const realGetRandomValues = webCrypto.getRandomValues.bind(webCrypto)
/** The MongoDB driver and BSON keep real randomness: their session ids must never repeat. */
const DRIVER = /[\\/]node_modules[\\/](?:bson|mongodb)[\\/]/
const realRandomUUID = webCrypto.randomUUID.bind(webCrypto)
const realGenerateKey = subtle.generateKey.bind(subtle)
const realExportKey = subtle.exportKey.bind(subtle)

/** An in process HTTP endpoint that `fetch` reaches instead of the network. */
export type Route = (request: Request) => Promise<Response>

function fakeDate(clock: FakeClock): DateConstructor {
  function FakeDate(this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined) return new RealDate(clock.now()).toString()
    return Reflect.construct(RealDate, args.length === 0 ? [clock.now()] : args, new.target)
  }
  FakeDate.prototype = RealDate.prototype
  Object.assign(FakeDate, { now: () => clock.now(), parse: RealDate.parse, UTC: RealDate.UTC })
  return FakeDate as unknown as DateConstructor
}

const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex")

/** A key pair derived from 32 seeded bytes, so key generation is as repeatable as the seed. */
export function derivedJwk(
  kind: "Ed25519" | "P-256",
  seed: Buffer,
): Record<string, string> & { kty: string; d: string } {
  if (kind === "Ed25519") {
    const key = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8, seed]),
      format: "der",
      type: "pkcs8",
    })
    const jwk = key.export({ format: "jwk" })
    if (jwk.kty !== "OKP" || jwk.x === undefined || jwk.d === undefined)
      throw new Error("Expected an Ed25519 key")
    return { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }
  }
  const ecdh = createECDH("prime256v1")
  ecdh.setPrivateKey(seed)
  const point = ecdh.getPublicKey()
  return {
    kty: "EC",
    crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33).toString("base64url"),
    d: seed.toString("base64url"),
  }
}

function algorithmName(algorithm: unknown): { name: string; curve?: string } {
  if (typeof algorithm === "string") return { name: algorithm }
  if (typeof algorithm === "object" && algorithm !== null) {
    const name = Reflect.get(algorithm, "name")
    const curve = Reflect.get(algorithm, "namedCurve")
    return {
      name: typeof name === "string" ? name : "",
      ...(typeof curve === "string" ? { curve } : {}),
    }
  }
  return { name: "" }
}

async function seededKeyPair(
  random: SeededRandom,
  algorithm: unknown,
  extractable: boolean,
  usages: readonly webcrypto.KeyUsage[],
): Promise<webcrypto.CryptoKeyPair | undefined> {
  const { name, curve } = algorithmName(algorithm)
  const kind =
    name === "Ed25519" ? "Ed25519" : name === "ECDSA" && curve === "P-256" ? "P-256" : undefined
  if (kind === undefined) return undefined
  const { d, ...publicJwk } = derivedJwk(kind, random.bytes(32))
  const imported = kind === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" }
  const privateKey = await subtle.importKey(
    "jwk",
    { ...publicJwk, d },
    imported,
    extractable,
    usages.filter((usage) => usage === "sign"),
  )
  const publicKey = await subtle.importKey(
    "jwk",
    publicJwk,
    imported,
    true,
    usages.filter((usage) => usage === "verify"),
  )
  return { privateKey, publicKey }
}

function define(target: object, key: string, value: unknown): () => void {
  const saved = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  return () => {
    if (saved === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, saved)
  }
}

/**
 * Replaces the clock, the Web Crypto random sources, Ed25519 and P-256 key generation and `fetch` for the
 * duration of a recording, and puts them back on `restore`. Key pairs generated meanwhile are derived from
 * the seeded stream, JWK exports list their members in code point order (Bun and Node order them
 * differently), and `fetch` reaches only the given routes.
 */
export function installDeterminism(
  clock: FakeClock,
  random: SeededRandom,
  routes: ReadonlyMap<string, Route>,
): {
  restore(): void
  outbound: { method: string; url: string; headers: Headers; body: string }[]
} {
  const outbound: { method: string; url: string; headers: Headers; body: string }[] = []
  globalThis.Date = fakeDate(clock)
  const restoreRandom = define(
    webCrypto,
    "getRandomValues",
    (array: Parameters<typeof realGetRandomValues>[0]) => {
      if (DRIVER.test(new Error().stack ?? "")) return realGetRandomValues(array)
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      view.set(random.bytes(view.length))
      return array
    },
  )
  const restoreUuid = define(webCrypto, "randomUUID", () => {
    const bytes = random.bytes(16)
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = bytes.toString("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  })
  const restoreGenerate = define(
    subtle,
    "generateKey",
    async (algorithm: unknown, extractable: boolean, usages: readonly webcrypto.KeyUsage[]) =>
      (await seededKeyPair(random, algorithm, extractable, usages)) ??
      realGenerateKey(algorithm as Parameters<typeof realGenerateKey>[0], extractable, [...usages]),
  )
  const restoreExport = define(
    subtle,
    "exportKey",
    async (format: string, key: webcrypto.CryptoKey) => {
      if (format !== "jwk") return realExportKey(format as "raw", key)
      const exported = await realExportKey("jwk", key)
      return Object.fromEntries(Object.entries(exported).sort(([a], [b]) => (a < b ? -1 : 1)))
    },
  )
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const route = routes.get(url.origin)
      if (route === undefined)
        throw new Error(`A recording may not reach ${url.origin}; add a mock route for it`)
      const body = request.method === "GET" ? "" : await request.clone().text()
      outbound.push({ method: request.method, url: request.url, headers: request.headers, body })
      return route(request)
    },
    { preconnect: () => undefined },
  ) as typeof fetch
  return {
    outbound,
    restore() {
      globalThis.Date = RealDate
      restoreRandom()
      restoreUuid()
      restoreGenerate()
      restoreExport()
      globalThis.fetch = realFetch
    },
  }
}

/** A random identifier that the patched sources cannot influence, for scratch database names. */
export function scratchName(prefix: string): string {
  return `${prefix}_${realRandomUUID().replaceAll("-", "")}`
}
