import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import {
  allow,
  auth,
  type CollectionPolicies,
  collection,
  context,
  ctx,
  restrict,
  toStored,
} from "@canopy/policy"
import { exportJWK, SignJWT } from "jose"
import { BSON } from "mongodb"
import type { Fixture } from "./harness.ts"

const ISSUER = "https://idp.conformance.test/"
const PUBLISHABLE = "canopy_pk_conformance"
const SECRET = "canopy_sk_conformance"
const KEY_ID = "conformance-1"
/** 2026-01-01T00:00:00Z, long before any run, and 2100-01-01T00:00:00Z, long after. */
const ISSUED_AT = 1_767_225_600
const EXPIRES_AT = 4_102_444_800

const oid = (prefix: string, n: number): BSON.ObjectId =>
  new BSON.ObjectId(`${prefix}${n.toString(16).padStart(24 - prefix.length, "0")}`)
const date = (iso: string): Date => new Date(iso)
const i32 = (value: number): BSON.Int32 => new BSON.Int32(value)
const f64 = (value: number): BSON.Double => new BSON.Double(value)
const i64 = (value: bigint): BSON.Long => BSON.Long.fromBigInt(value)
const dec = (text: string): BSON.Decimal128 => BSON.Decimal128.fromString(text)
const bin = (bytes: number[], subType = 0): BSON.Binary =>
  new BSON.Binary(Uint8Array.from(bytes), subType)

type Doc = Record<string, unknown>

/** Keys are never integer like, so JSON round trips keep their order. */
function canonical(documents: readonly Doc[]): unknown[] {
  return documents.map(
    (doc) => JSON.parse(BSON.EJSON.stringify(doc, { relaxed: false })) as unknown,
  )
}

function todos(): Doc[] {
  const rows: [
    number,
    string,
    string,
    number,
    string,
    Date | null | undefined,
    string[] | undefined,
    Doc | undefined,
  ][] = [
    [
      1,
      "alice",
      "active",
      2,
      "2026-01-01T08:00:00.000Z",
      date("2026-02-01T00:00:00Z"),
      ["home", "urgent"],
      { source: "web", score: 1.5 },
    ],
    [
      2,
      "alice",
      "done",
      1,
      "2026-01-02T09:30:00.000Z",
      null,
      ["work"],
      { source: "api", score: 2.5 },
    ],
    [
      3,
      "alice",
      "active",
      3,
      "2026-01-03T10:00:00.000Z",
      undefined,
      [],
      { source: "web", score: 0 },
    ],
    [
      4,
      "alice",
      "active",
      3,
      "2026-01-03T10:00:00.000Z",
      date("2026-01-20T00:00:00Z"),
      ["work", "urgent"],
      { source: "cli", score: -0 },
    ],
    [
      5,
      "alice",
      "blocked",
      2,
      "2026-01-05T12:00:00.123Z",
      date("2026-01-06T00:00:00Z"),
      ["home"],
      { source: "api", score: 9.75 },
    ],
    [
      6,
      "alice",
      "done",
      1,
      "2026-01-06T07:45:00.000Z",
      date("2026-01-07T00:00:00Z"),
      ["work", "home"],
      { source: "web", score: 3 },
    ],
    [
      7,
      "bob",
      "active",
      1,
      "2026-01-07T07:00:00.000Z",
      date("2026-03-01T00:00:00Z"),
      ["work"],
      { source: "web", score: 4 },
    ],
    [
      8,
      "alice",
      "active",
      2,
      "2026-01-08T18:00:00.000Z",
      null,
      undefined,
      { source: "cli", score: 5 },
    ],
    [
      9,
      "bob",
      "done",
      2,
      "2026-01-09T09:00:00.000Z",
      undefined,
      ["home"],
      { source: "api", score: 6 },
    ],
    [
      10,
      "alice",
      "active",
      1,
      "2026-01-10T11:11:11.000Z",
      date("2026-01-30T00:00:00Z"),
      ["urgent"],
      { source: "api", score: 7 },
    ],
    [
      11,
      "bob",
      "blocked",
      3,
      "2026-01-11T14:00:00.000Z",
      date("2026-01-12T00:00:00Z"),
      ["work", "urgent"],
      { source: "cli", score: 8 },
    ],
    [
      12,
      "bob",
      "active",
      2,
      "2026-01-12T16:30:00.000Z",
      date("2026-02-12T00:00:00Z"),
      [],
      undefined,
    ],
  ]
  return rows.map(([n, owner, status, priority, created, due, tags, meta]) => {
    const doc: Doc = {
      _id: oid("6f1", n),
      ownerId: owner,
      title: `todo ${n}`,
      status,
      priority: i32(priority),
      createdAt: date(created),
    }
    if (due !== undefined) doc["dueAt"] = due
    if (tags !== undefined) doc["tags"] = tags
    if (meta !== undefined)
      doc["meta"] = { source: meta["source"], score: f64(meta["score"] as number) }
    doc["internalNotes"] = `secret-${n}`
    return doc
  })
}

function staff(): Doc[] {
  const rows: [number, string, string, number, boolean | undefined, string][] = [
    [1, "Ada", "core", 120, undefined, "2020-03-01T00:00:00Z"],
    [2, "Brook", "core", 110, false, "2021-06-15T00:00:00Z"],
    [3, "Cy", "support", 90, true, "2019-01-10T00:00:00Z"],
    [4, "Dara", "support", 95, undefined, "2022-09-01T00:00:00Z"],
    [5, "Eli", "sales", 100, false, "2023-02-20T00:00:00Z"],
    [6, "Fay", "sales", 105, true, "2018-11-05T00:00:00Z"],
    [7, "Gus", "core", 130, undefined, "2024-04-04T00:00:00Z"],
  ]
  return rows.map(([id, name, team, salary, archived, joined]) => ({
    _id: i32(id),
    name,
    team,
    salary: i32(salary),
    ...(archived === undefined ? {} : { archived }),
    joined: date(joined),
  }))
}

function numbers(): Doc[] {
  const rows: [number, string, unknown][] = [
    [1, "int 2", i32(2)],
    [2, "long 2", i64(2n)],
    [3, "double 2", f64(2)],
    [4, "decimal 2", dec("2")],
    [5, "nan", f64(Number.NaN)],
    [6, "negative zero", f64(-0)],
    [7, "int 0", i32(0)],
    [8, "null", null],
    [9, "missing", undefined],
    [10, "negative infinity", f64(Number.NEGATIVE_INFINITY)],
    [11, "positive infinity", f64(Number.POSITIVE_INFINITY)],
    [12, "long above 2^53", i64(9_007_199_254_740_993n)],
    [13, "double 1.5", f64(1.5)],
    [14, "string 2", "2"],
    [15, "decimal 1.50", dec("1.50")],
    [16, "int negative 5", i32(-5)],
    [17, "decimal nan", dec("NaN")],
    [18, "double 0.1", f64(0.1)],
  ]
  return rows.map(([n, label, value]) => ({
    _id: oid("6f5", n),
    label,
    ...(value === undefined ? {} : { n: value }),
  }))
}

function events(): Doc[] {
  const base = (id: number): Doc => ({ _id: `e${String(id).padStart(2, "0")}` })
  return [
    {
      ...base(1),
      kind: "alpha",
      at: date("1969-12-31T23:59:59.999Z"),
      ref: oid("6f6", 1),
      payload: bin([]),
      nested: { depth: i32(1), label: "x" },
      flag: false,
    },
    {
      ...base(2),
      kind: "Alpha",
      at: date("1970-01-01T00:00:00.000Z"),
      ref: oid("6f6", 2),
      payload: bin([0]),
      nested: { depth: i32(2), label: "y" },
      flag: true,
    },
    {
      ...base(3),
      kind: "beta",
      at: date("2026-03-01T12:00:00.001Z"),
      ref: oid("6f6", 3),
      payload: bin([0, 1]),
      nested: { depth: f64(2.5), label: "z" },
      flag: false,
    },
    {
      ...base(4),
      kind: "éclair",
      at: date("2026-03-01T12:00:00.000Z"),
      ref: oid("6f6", 4),
      payload: bin([1]),
      nested: { depth: i32(3) },
      flag: true,
    },
    {
      ...base(5),
      kind: "Z",
      at: date("2099-12-31T23:59:59.999Z"),
      ref: oid("6f6", 5),
      payload: bin([255]),
      nested: { label: "no depth" },
    },
    {
      ...base(6),
      kind: "",
      at: date("2026-03-01T12:00:00.001Z"),
      ref: oid("6f6", 6),
      payload: bin([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 4),
      flag: false,
    },
    {
      ...base(7),
      kind: "alpha",
      at: date("2026-03-02T00:00:00.000Z"),
      ref: oid("6f6", 7),
      payload: bin([9, 9], 128),
      nested: { depth: i32(1), label: "x" },
    },
    {
      ...base(8),
      kind: "日本",
      at: date("2026-03-03T00:00:00.000Z"),
      nested: { depth: i64(4n) },
      flag: true,
    },
    { ...base(9), kind: null, at: null, ref: oid("6f6", 9), payload: bin([0, 0]) },
    { ...base(10), at: "unknown", ref: oid("6f6", 10) },
    {
      ...base(11),
      kind: "beta",
      at: date("2026-03-01T12:00:00.001Z"),
      ref: oid("6f6", 11),
      stamp: new BSON.Timestamp({ t: 1_000, i: 2 }),
    },
    {
      ...base(12),
      kind: "a b",
      at: date("2026-03-04T00:00:00.000Z"),
      ref: oid("6f6", 12),
      stamp: new BSON.Timestamp({ t: 1_000, i: 1 }),
    },
    {
      ...base(13),
      kind: "alpha",
      at: date("2026-03-05T00:00:00.000Z"),
      stamp: new BSON.Timestamp({ t: 999, i: 7 }),
    },
  ]
}

function odd(): Doc[] {
  return [
    { _id: "o1", v: new BSON.BSONRegExp("^a", "i"), w: 1 },
    { _id: "o2", v: new BSON.BSONRegExp("b+"), w: 2 },
    { _id: "o5", v: "plain", w: 5 },
    { _id: "o6", v: [1, 2], w: 6 },
  ]
}

function symbols(): Doc[] {
  return [
    { _id: "y1", v: new BSON.BSONSymbol("sym") },
    { _id: "y2", v: new BSON.BSONSymbol("tym") },
    { _id: "y3", v: "sym" },
    { _id: "y4", v: "rym" },
  ]
}

function authored(): CollectionPolicies[] {
  return [
    collection("todos", {
      exposed: true,
      realtime: true,
      policies: [
        allow
          .read("authenticated")
          .where({ ownerId: auth("sub") })
          .named("read own"),
        allow.read("admin").named("admins read all"),
      ],
      fields: {
        read: {
          default: { omit: ["internalNotes", "meta.score"] },
          admin: { omit: ["internalNotes"] },
        },
      },
    }),
    collection("staff", {
      exposed: true,
      policies: [
        allow.read("authenticated").named("staff read"),
        restrict
          .read("authenticated")
          .where({ archived: { $ne: true } })
          .named("hide archived"),
      ],
      fields: { read: { default: { omit: ["salary"] } } },
    }),
    collection("tasks", {
      exposed: true,
      policies: [
        allow
          .read("authenticated")
          .where({ projectId: { $in: ctx("projectIds") } })
          .named("read project tasks"),
      ],
    }),
    collection("numbers", { exposed: true, policies: [allow.read("public").named("public read")] }),
    collection("events", {
      exposed: true,
      policies: [allow.read("authenticated").named("authenticated read")],
    }),
    collection("odd", {
      exposed: true,
      policies: [allow.read("authenticated").named("authenticated read")],
    }),
    collection("symbols", {
      exposed: true,
      policies: [allow.read("authenticated").named("authenticated read")],
    }),
    collection("sealed", {
      exposed: true,
      policies: [allow.insert("authenticated").check({ ok: true }).named("insert only")],
    }),
    collection("hidden", {
      exposed: false,
      policies: [allow.read("authenticated").named("authenticated read")],
    }),
  ]
}

function tasks(): Doc[] {
  const projects = [1, 1, 2, 2, 3, 3]
  return projects.map((project, index) => ({
    _id: oid("6f3", index + 1),
    projectId: oid("6f4", project),
    title: `task ${index + 1}`,
  }))
}

/**
 * Builds the committed fixture: documents, policies, callers and the signing material of their tokens. Every
 * value is derived from constants of this file, including the key (the SHA-256 of a label) and the tokens (Ed25519
 * signatures are deterministic, and the times are fixed), so two builds are byte identical. The key signs
 * test tokens only; its public half is in the fixture and nothing else trusts it.
 */
export async function buildFixture(): Promise<Fixture> {
  const seed = createHash("sha256").update("canopy conformance http find signing key v1").digest()
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  })
  const jwk = {
    ...(await exportJWK(createPublicKey(privateKey))),
    kid: KEY_ID,
    alg: "EdDSA",
    use: "sig",
  }
  const sign = (claims: Record<string, unknown>, extra: { exp?: number; iss?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: KEY_ID })
      .setIssuer(extra.iss ?? ISSUER)
      .setIssuedAt(ISSUED_AT)
      .setExpirationTime(extra.exp ?? EXPIRES_AT)
      .sign(privateKey)
  const valid = await sign({ sub: "alice" })
  const bearer = (token: string): Record<string, string> => ({
    apikey: PUBLISHABLE,
    authorization: `Bearer ${token}`,
  })
  const tampered = `${valid.slice(0, -4)}${valid.endsWith("AAAA") ? "BBBB" : "AAAA"}`
  const definitions = authored()
  return {
    name: "find",
    basePath: "/rest/v1",
    readLimits: { defaultLimit: 5, maxLimit: 10, maxSkip: 20 },
    idTypes: {},
    auth: {
      issuer: ISSUER,
      rolesClaim: "roles",
      jwks: { keys: [jwk] },
      publishableKeys: [PUBLISHABLE],
      secretKeys: [SECRET],
    },
    callers: {
      none: {},
      anon: { apikey: PUBLISHABLE },
      alice: bearer(valid),
      bob: bearer(await sign({ sub: "bob" })),
      carol: bearer(await sign({ sub: "carol", roles: ["admin"] })),
      service: { apikey: SECRET },
      "service-bearer": { authorization: `Bearer ${SECRET}` },
      "unknown-key": { apikey: "canopy_pk_unknown" },
      expired: bearer(await sign({ sub: "alice" }, { exp: ISSUED_AT + 3600 })),
      tampered: bearer(tampered),
      "wrong-issuer": bearer(
        await sign({ sub: "alice" }, { iss: "https://other.conformance.test/" }),
      ),
      "service-claim": bearer(await sign({ sub: "mallory", roles: ["service"] })),
    },
    collections: {
      todos: canonical(todos()),
      staff: canonical(staff()),
      tasks: canonical(tasks()),
      memberships: canonical([
        { _id: oid("6f2", 1), userId: "alice", projectId: oid("6f4", 1) },
        { _id: oid("6f2", 2), userId: "alice", projectId: oid("6f4", 2) },
        { _id: oid("6f2", 3), userId: "bob", projectId: oid("6f4", 2) },
      ]),
      numbers: canonical(numbers()),
      events: canonical(events()),
      odd: canonical(odd()),
      symbols: canonical(symbols()),
      sealed: canonical([
        { _id: "s1", v: 1 },
        { _id: "s2", v: 2 },
      ]),
      hidden: canonical([
        { _id: "h1", v: "hidden one" },
        { _id: "h2", v: "hidden two" },
      ]),
    },
    policies: {
      collections: definitions.map((def) => toStored(def, { version: 1 })),
      contexts: context({
        projectIds: {
          from: "memberships",
          where: { userId: auth("sub") },
          select: "projectId",
          max: 10,
          ttl: "5m",
        },
      }),
    },
  }
}
