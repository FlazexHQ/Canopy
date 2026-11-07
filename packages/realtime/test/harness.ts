import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { type CollectionPolicies, createPolicySet } from "@canopy/policy"
import {
  type ClientMessage,
  canonicalString,
  decodeServerMessage,
  encodeMessage,
  type SequencedMessage,
  SUBPROTOCOL,
  unbatch,
} from "@canopy/protocol"
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import WebSocket from "ws"
import { attach, createRealtime, type Realtime, type RealtimeOptions } from "../src/index.ts"

const ISSUER = "https://issuer.test/"
const AUDIENCE = "https://api.test"

/** A signing key and its public JWKS. */
export interface Keys {
  readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
  readonly jwk: JWK
}

export async function makeKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
  return { privateKey, jwk }
}

export async function token(
  keys: Keys,
  claims: Record<string, unknown>,
  expiresIn = "1h",
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(keys.privateKey)
}

/** A running engine on an ephemeral port. */
export interface Running {
  readonly realtime: Realtime
  readonly url: string
  readonly db: Db
  readonly client: MongoClient
  stop(): Promise<void>
}

export async function startEngine(
  uri: string,
  dbName: string,
  keys: Keys,
  policies: readonly CollectionPolicies[],
  overrides: Partial<RealtimeOptions> = {},
): Promise<Running> {
  const client = new MongoClient(uri)
  await client.connect()
  const realtime = await createRealtime({
    mongo: client,
    database: dbName,
    metaDatabase: `${dbName}_meta`,
    auth: { jwks: { keys: [keys.jwk] }, issuer: ISSUER, audience: AUDIENCE, rolesClaim: "roles" },
    keys: { publishable: ["pk_test"] },
    policies: { set: createPolicySet(policies) },
    checkpoints: "off",
    observerLingerMs: 0,
    ...overrides,
  })
  const server: Server = createServer((_request, response) => {
    response.statusCode = 404
    response.end()
  })
  const attachment = await attach(realtime, server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    realtime,
    url: `ws://127.0.0.1:${port}/realtime/v1`,
    db: client.db(dbName),
    client,
    async stop() {
      await realtime.close()
      await attachment.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await client.close()
    },
  }
}

/** The view one subscription should show, rebuilt from protocol messages the way an SDK does. */
export class TestClient {
  readonly messages: SequencedMessage[] = []
  readonly docs = new Map<string, Record<string, unknown>>()
  readonly members = new Map<string, Set<string>>()
  readonly ready = new Set<string>()
  closeCode: number | undefined
  private readonly socket: WebSocket
  private readonly waiters: { test: () => boolean; resolve: () => void }[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on("message", (data) => {
      const message = decodeServerMessage(data.toString())
      if (message === undefined) return
      for (const part of unbatch(message)) {
        if (part.t === "pong") continue
        this.messages.push(part)
        this.apply(part)
      }
      this.check()
    })
    socket.on("close", (code) => {
      this.closeCode = code
      this.check()
    })
  }

  static async open(url: string): Promise<TestClient> {
    const socket = new WebSocket(url, SUBPROTOCOL)
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    return new TestClient(socket)
  }

  static async connect(
    url: string,
    tokenValue?: string,
    extra: Record<string, unknown> = {},
  ): Promise<TestClient> {
    const client = await TestClient.open(url)
    client.send({
      t: "hello",
      v: 1,
      key: "pk_test",
      ...(tokenValue === undefined ? {} : { token: tokenValue }),
      caps: ["diff"],
      ...extra,
    } as ClientMessage)
    await client.until(
      () => client.messages.some((m) => m.t === "welcome") || client.closeCode !== undefined,
    )
    return client
  }

  send(message: ClientMessage): void {
    this.socket.send(encodeMessage(message))
  }

  close(): void {
    this.socket.close()
  }

  terminate(): void {
    this.socket.terminate()
  }

  /** Ends the session for good (`bye`), so the server does not keep it for a resume. */
  bye(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.send({ t: "bye" })
    this.socket.close()
  }

  get welcome(): Extract<SequencedMessage, { t: "welcome" }> | undefined {
    return this.messages.find(
      (m): m is Extract<SequencedMessage, { t: "welcome" }> => m.t === "welcome",
    )
  }

  get lastSeq(): number {
    return this.messages.reduce((max, m) => Math.max(max, m.seq), 0)
  }

  private apply(message: SequencedMessage): void {
    switch (message.t) {
      case "added": {
        const key = `${message.c}/${canonicalString(message.id)}`
        if (message.d !== undefined) this.docs.set(key, message.d)
        for (const sub of message.s) {
          const set = this.members.get(sub) ?? new Set()
          set.add(key)
          this.members.set(sub, set)
        }
        return
      }
      case "changed": {
        const key = `${message.c}/${canonicalString(message.id)}`
        if (message.replace === true && message.d !== undefined) {
          this.docs.set(key, message.d)
          return
        }
        const doc = { ...(this.docs.get(key) ?? {}) }
        Object.assign(doc, message.set ?? {})
        for (const field of message.unset ?? []) delete doc[field]
        this.docs.set(key, doc)
        return
      }
      case "removed": {
        const key = `${message.c}/${canonicalString(message.id)}`
        for (const sub of message.s) this.members.get(sub)?.delete(key)
        return
      }
      case "ready":
        this.ready.add(message.s)
        return
      case "resync":
        for (const sub of message.s ?? [...this.members.keys()]) {
          this.members.delete(sub)
          this.ready.delete(sub)
        }
        return
      default:
        return
    }
  }

  /** The documents a subscription shows, keyed by document key. */
  view(sub: string): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>()
    for (const key of this.members.get(sub) ?? []) {
      const doc = this.docs.get(key)
      if (doc !== undefined) out.set(key, doc)
    }
    return out
  }

  ids(sub: string): unknown[] {
    return [...this.view(sub).values()].map((doc) => doc["_id"])
  }

  private check(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.test()) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }

  async until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (test()) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(
          new Error(
            `timed out; messages: ${JSON.stringify(this.messages.slice(-10).map((m) => m.t))}`,
          ),
        )
      }, timeoutMs)
      const waiter = {
        test,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      }
      this.waiters.push(waiter)
    })
  }

  async subscribe(id: string, c: string, q: Record<string, unknown> = {}): Promise<void> {
    this.send({ t: "sub", id, c, q } as ClientMessage)
    await this.until(
      () => this.ready.has(id) || this.messages.some((m) => m.t === "nosub" && m.s === id),
    )
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
