import { allow, auth, collection } from "@canopy/policy"
import type { ClientMessage, SequencedMessage } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("read own"),
    allow
      .read("authenticated")
      .where({ orgId: { $in: auth("orgs") } })
      .named("read org"),
  ],
  fields: { read: { default: { omit: ["internal"] } } },
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

type Ready = Extract<SequencedMessage, { t: "ready" }>
type Nosub = Extract<SequencedMessage, { t: "nosub" }>

suite("sub option explain", () => {
  const dbName = `canopy_rt_explain_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  const clients: TestClient[] = []

  beforeAll(async () => {
    keys = await makeKeys()
    engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [notes], {
      keys: { publishable: ["pk_test"], secret: ["sk_test"] },
    })
    await engine.db.collection("notes").insertMany([
      { _id: "n1" as never, ownerId: "u1", status: "open" },
      { _id: "n2" as never, ownerId: "u2", status: "open" },
    ])
  })

  afterAll(async () => {
    for (const client of clients.splice(0)) client.bye()
    await engine.db.dropDatabase()
    await engine.stop()
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.bye()
  })

  const connect = async (extra: Record<string, unknown>, tokenValue?: string) => {
    const client = await TestClient.connect(engine.url, tokenValue, extra)
    clients.push(client)
    return client
  }

  const subscribe = async (
    client: TestClient,
    id: string,
    q: Record<string, unknown>,
    o: Record<string, unknown>,
  ): Promise<Ready | Nosub | undefined> => {
    client.send({ t: "sub", id, c: "notes", q, o } as ClientMessage)
    await client.until(() =>
      client.messages.some((m) => (m.t === "ready" || m.t === "nosub") && m.s === id),
    )
    return client.messages.find(
      (m): m is Ready | Nosub => (m.t === "ready" || m.t === "nosub") && m.s === id,
    )
  }

  it("refuses explanations to app users and publishable keys, in every form", async () => {
    const user = await connect({}, await token(keys, { sub: "u1" }))
    const anon = await connect({})
    for (const [client, o] of [
      [user, { explain: true }],
      [user, { explain: { claims: { sub: "u2" } } }],
      [anon, { explain: true }],
    ] as const) {
      const answer = await subscribe(client, `s${client.lastSeq}`, {}, o)
      expect(answer).toMatchObject({
        t: "nosub",
        err: { code: "CANOPY_FORBIDDEN", msg: "Explanations are only available with a secret key" },
      })
    }
    expect(user.messages.some((m) => m.t === "ready" && m.explain !== undefined)).toBe(false)
    expect(user.messages.some((m) => m.t === "added")).toBe(false)
    const plain = await subscribe(user, "plain", {}, {})
    expect(plain).toMatchObject({ t: "ready" })
    expect(plain && "explain" in plain).toBe(false)
  })

  it("explains a stated caller to a secret key, without the values that made a policy fail", async () => {
    const service = await connect({ key: "sk_test" })
    const ready = await subscribe(
      service,
      "as_u1",
      { filter: { status: "open" } },
      { explain: { claims: { sub: "u1", orgs: "o_wrong_shape" } } },
    )
    expect(ready?.t).toBe("ready")
    const report = ready?.t === "ready" ? ready.explain : undefined
    expect(report).toMatchObject({
      collection: "notes",
      op: "read",
      roles: ["authenticated"],
      bypass: false,
      exposed: true,
      granted: true,
      effectiveFilter: { $and: [{ status: "open" }, { ownerId: "u1" }] },
      readable: { kind: "omit", paths: ["internal"] },
    })
    const using = report?.["using"] as { policies: Record<string, unknown>[] } | undefined
    const policies = using?.policies
    expect(policies).toEqual([
      {
        name: "read own",
        kind: "permissive",
        applies: true,
        reason: "applies",
        resolved: { ownerId: "u1" },
      },
      {
        name: "read org",
        kind: "permissive",
        applies: false,
        issue: { kind: "shape", variable: "$auth:orgs" },
        reason: "variable $auth:orgs is invalid (shape)",
      },
    ])
    expect(String(report?.["text"])).toContain('"read org"')
    expect(JSON.stringify(service.messages)).not.toContain("o_wrong_shape")
    expect(service.ids("as_u1")).toEqual(["n1", "n2"])

    const self = await subscribe(service, "self", {}, { explain: true })
    expect(self?.t === "ready" ? self.explain : undefined).toMatchObject({
      roles: ["service"],
      bypass: true,
      text: expect.stringContaining("service bypasses DLS"),
    })
    const again = service.messages.filter((m) => m.t === "ready" && m.s === "self")
    expect(again).toHaveLength(1)
  })

  it("answers nosub for an explanation of a collection that is not realtime", async () => {
    const service = await connect({ key: "sk_test" })
    service.send({ t: "sub", id: "x", c: "missing", q: {}, o: { explain: true } } as ClientMessage)
    await service.until(() => service.messages.some((m) => m.t === "nosub" && m.s === "x"))
    expect(service.messages.find((m) => m.t === "nosub" && m.s === "x")).toMatchObject({
      err: { code: "CANOPY_NOT_FOUND" },
    })
  })
})
