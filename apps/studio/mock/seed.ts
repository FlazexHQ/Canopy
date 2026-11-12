const day = 86_400_000

function oid(index: number, prefix = "65f1a2b3c4d5e6f7a8b9"): { $oid: string } {
  return { $oid: `${prefix}${index.toString(16).padStart(4, "0")}` }
}

/** Sample documents in canonical EJSON, keyed by collection. */
export function seedCollections(): Record<string, Record<string, unknown>[]> {
  const owners = ["u_alice", "u_bob", "u_carol"]
  const todos = Array.from({ length: 24 }, (_, index) => ({
    _id: oid(index + 1),
    title: [
      "Buy milk",
      "Write the quarterly report",
      "Book flights",
      "Review pull request",
      "Call the plumber",
      "Plan the offsite",
    ][index % 6],
    done: index % 3 === 0,
    ownerId: owners[index % 3],
    orgId: index % 2 === 0 ? "o1" : "o2",
    shared: index % 4 === 0,
    priority: (index % 5) + 1,
    tags: index % 2 === 0 ? ["home"] : ["work", "q4"],
    createdAt: { $date: new Date(Date.UTC(2026, 9, 1 + index, 9, 30)).toISOString() },
    ...(index % 6 === 0 ? { internalNotes: "Escalated by support" } : {}),
  }))
  const notes = Array.from({ length: 6 }, (_, index) => ({
    _id: oid(index + 1, "75f1a2b3c4d5e6f7a8b9"),
    body: `Meeting notes ${index + 1}`,
    authorId: owners[index % 3],
    pinned: index === 0,
    updatedAt: { $date: new Date(Date.UTC(2026, 10, 1 + index)).toISOString() },
  }))
  const orders = Array.from({ length: 8 }, (_, index) => ({
    _id: `ord_${1000 + index}`,
    customerId: owners[index % 3],
    total: { $numberDecimal: (19.99 + index * 7.5).toFixed(2) },
    items: index + 1,
    status: ["paid", "shipped", "refunded", "paid"][index % 4],
    address: {
      city: ["Lisbon", "Pune", "Austin"][index % 3],
      country: ["PT", "IN", "US"][index % 3],
    },
  }))
  return { todos, notes, orders, feedback: [] }
}

/** A realtime connection as the engine's inspector reports it, with the claims its token carried. */
export interface SeedConnection {
  readonly sid: string
  readonly subject: string
  readonly roles: readonly string[]
  readonly keyId: string | undefined
  readonly connected: boolean
  readonly openedAt: Date
  readonly tokenExpiresAt: Date | undefined
  readonly subscriptions: readonly {
    readonly id: string
    readonly coll: string
    readonly observer: string
  }[]
  readonly documents: number
  readonly queuedBytes: number
  readonly lastSeq: number
  readonly claims: Readonly<Record<string, unknown>> | null
}

/** Realtime connections with the claims their tokens carried. */
export function seedConnections(now: number): SeedConnection[] {
  return [
    {
      sid: "s_7f3a",
      subject: "u_alice",
      roles: ["authenticated"],
      claims: { sub: "u_alice", email: "alice@example.com", org_ids: ["o1"] },
      keyId: "key_pk_1",
      connected: true,
      openedAt: new Date(now - 12 * 60_000),
      tokenExpiresAt: new Date(now + 48 * 60_000),
      subscriptions: [{ id: "q1", coll: "todos", observer: "obs_todos_alice" }],
      documents: 8,
      queuedBytes: 0,
      lastSeq: 214,
    },
    {
      sid: "s_91bc",
      subject: "u_bob",
      roles: ["authenticated"],
      claims: { sub: "u_bob", email: "bob@example.com", org_ids: ["o1", "o2"] },
      keyId: "key_pk_1",
      connected: true,
      openedAt: new Date(now - 3 * 60_000),
      tokenExpiresAt: new Date(now + 57 * 60_000),
      subscriptions: [
        { id: "q1", coll: "todos", observer: "obs_todos_bob" },
        { id: "q2", coll: "notes", observer: "obs_notes_bob" },
      ],
      documents: 11,
      queuedBytes: 2048,
      lastSeq: 37,
    },
    {
      sid: "s_02de",
      subject: "anon",
      roles: ["anon"],
      claims: null,
      keyId: "key_pk_1",
      connected: false,
      openedAt: new Date(now - 40 * 60_000),
      tokenExpiresAt: undefined,
      subscriptions: [{ id: "q1", coll: "todos", observer: "obs_todos_anon" }],
      documents: 0,
      queuedBytes: 0,
      lastSeq: 2,
    },
  ]
}

/** A sampled request as `canopy.request_log` stores it. */
export interface SeedLogEntry {
  readonly _id: { readonly $oid: string }
  readonly at: Date
  readonly surface: "rest" | "graphql" | "auth" | "admin" | "realtime"
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  readonly ip?: string
  readonly requestId?: string
}

/** Sampled requests, newest first, including denials. */
export function seedLogs(now: number): SeedLogEntry[] {
  const shapes: Omit<SeedLogEntry, "_id" | "at" | "requestId">[] = [
    {
      surface: "rest",
      method: "GET",
      path: "/rest/v1/todos",
      status: 200,
      durationMs: 12,
      ip: "203.0.113.7",
    },
    {
      surface: "rest",
      method: "POST",
      path: "/rest/v1/todos",
      status: 201,
      durationMs: 31,
      ip: "203.0.113.7",
    },
    {
      surface: "rest",
      method: "PATCH",
      path: "/rest/v1/todos/65f1a2b3c4d5e6f7a8b90001",
      status: 403,
      durationMs: 9,
      ip: "198.51.100.4",
    },
    {
      surface: "rest",
      method: "DELETE",
      path: "/rest/v1/todos/65f1a2b3c4d5e6f7a8b90002",
      status: 403,
      durationMs: 7,
      ip: "198.51.100.4",
    },
    {
      surface: "rest",
      method: "POST",
      path: "/rest/v1/orders",
      status: 403,
      durationMs: 4,
      ip: "192.0.2.10",
    },
    {
      surface: "auth",
      method: "POST",
      path: "/auth/v1/sign-in/email",
      status: 401,
      durationMs: 120,
      ip: "192.0.2.10",
    },
    {
      surface: "rest",
      method: "GET",
      path: "/rest/v1/orders",
      status: 401,
      durationMs: 2,
      ip: "192.0.2.10",
    },
    {
      surface: "admin",
      method: "GET",
      path: "/admin/v1/collections",
      status: 200,
      durationMs: 18,
      ip: "127.0.0.1",
    },
    {
      surface: "rest",
      method: "GET",
      path: "/rest/v1/notes",
      status: 500,
      durationMs: 950,
      ip: "203.0.113.7",
    },
  ]
  return Array.from({ length: 36 }, (_, index) => {
    const shape = shapes[index % shapes.length] as Omit<SeedLogEntry, "_id" | "at" | "requestId">
    return {
      _id: { $oid: (0xffffff - index).toString(16).padStart(24, "6") },
      at: new Date(now - index * 37_000),
      requestId: `req_${(9000 + index).toString(36)}`,
      ...shape,
    }
  })
}

/** An app user of built in auth, as `AuthUser` of `@canopy/auth`. */
export interface SeedUser {
  readonly id: string
  readonly email: string | undefined
  readonly emailVerified: boolean
  readonly name: string | undefined
  readonly isAnonymous: boolean
  readonly roles: readonly string[]
  readonly appMetadata: Readonly<Record<string, unknown>>
  readonly userMetadata: Readonly<Record<string, unknown>>
  readonly banned: boolean
  readonly banReason: string | undefined
  readonly banExpires: Date | undefined
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** A session of an app user. */
export interface SeedSession {
  readonly id: string
  readonly userId: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date
  readonly ipAddress: string | undefined
  readonly userAgent: string | undefined
}

/** App users of built in auth. */
export function seedUsers(now: number): SeedUser[] {
  const user = (
    id: string,
    email: string,
    name: string,
    ageDays: number,
    extra: Partial<SeedUser>,
  ): SeedUser => ({
    id,
    email,
    emailVerified: true,
    name,
    isAnonymous: false,
    roles: [],
    appMetadata: {},
    userMetadata: {},
    banned: false,
    banReason: undefined,
    banExpires: undefined,
    createdAt: new Date(now - ageDays * day),
    updatedAt: new Date(now - ageDays * day),
    ...extra,
  })
  return [
    user("u_alice", "alice@example.com", "Alice Martin", 40, {
      appMetadata: { org_ids: ["o1"] },
      userMetadata: { theme: "dark" },
    }),
    user("u_bob", "bob@example.com", "Bob Okafor", 12, {
      roles: ["editor"],
      appMetadata: { org_ids: ["o1", "o2"] },
    }),
    user("u_carol", "carol@example.com", "Carol Singh", 3, {
      emailVerified: false,
      banned: true,
      banReason: "spam",
      appMetadata: { org_ids: ["o2"] },
    }),
  ]
}

/** Sessions of the seeded users. */
export function seedSessions(now: number): SeedSession[] {
  return [
    {
      id: "ses_1",
      userId: "u_alice",
      createdAt: new Date(now - 3_600_000),
      updatedAt: new Date(now - 60_000),
      expiresAt: new Date(now + 6 * day),
      ipAddress: "203.0.113.7",
      userAgent: "Firefox 146",
    },
    {
      id: "ses_2",
      userId: "u_alice",
      createdAt: new Date(now - 2 * day),
      updatedAt: new Date(now - day),
      expiresAt: new Date(now + 5 * day),
      ipAddress: "198.51.100.4",
      userAgent: "Safari 26",
    },
  ]
}
