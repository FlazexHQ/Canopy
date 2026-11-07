import type { AppUser, LogEntry, RealtimeConnection } from "../src/api/contract.ts"

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

/** Realtime connections with the claims their tokens carried. */
export function seedConnections(
  now: number,
): (RealtimeConnection & { claims: Record<string, unknown> | null })[] {
  return [
    {
      sid: "s_7f3a",
      subject: "u_alice",
      roles: ["authenticated"],
      claims: { sub: "u_alice", email: "alice@example.com", org_ids: ["o1"] },
      keyId: "key_pk_1",
      connected: true,
      transport: "websocket",
      openedAt: new Date(now - 12 * 60_000).toISOString(),
      tokenExpiresAt: new Date(now + 48 * 60_000).toISOString(),
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
      transport: "sse",
      openedAt: new Date(now - 3 * 60_000).toISOString(),
      tokenExpiresAt: new Date(now + 57 * 60_000).toISOString(),
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
      transport: "long-poll",
      openedAt: new Date(now - 40 * 60_000).toISOString(),
      tokenExpiresAt: null,
      subscriptions: [{ id: "q1", coll: "todos", observer: "obs_todos_anon" }],
      documents: 0,
      queuedBytes: 0,
      lastSeq: 2,
    },
  ]
}

/** Sampled request logs, including policy denials. */
export function seedLogs(now: number): LogEntry[] {
  const entries: LogEntry[] = []
  const shapes: Omit<LogEntry, "at" | "requestId">[] = [
    {
      method: "GET",
      path: "/rest/v1/todos",
      status: 200,
      durationMs: 12,
      role: "authenticated",
      collection: "todos",
      operation: "read",
    },
    {
      method: "POST",
      path: "/rest/v1/todos",
      status: 201,
      durationMs: 31,
      role: "authenticated",
      collection: "todos",
      operation: "insert",
    },
    {
      method: "PATCH",
      path: "/rest/v1/todos/65f1",
      status: 403,
      durationMs: 9,
      role: "authenticated",
      collection: "todos",
      operation: "update",
      code: "CANOPY_POLICY_VIOLATION",
      policy: "edit own",
    },
    {
      method: "DELETE",
      path: "/rest/v1/todos/65f2",
      status: 403,
      durationMs: 7,
      role: "authenticated",
      collection: "todos",
      operation: "delete",
      code: "CANOPY_POLICY_VIOLATION",
      policy: "archived is permanent",
    },
    {
      method: "POST",
      path: "/rest/v1/orders",
      status: 403,
      durationMs: 4,
      role: "anon",
      collection: "orders",
      operation: "insert",
      code: "CANOPY_FORBIDDEN",
    },
    {
      method: "GET",
      path: "/rest/v1/notes",
      status: 200,
      durationMs: 15,
      role: "authenticated",
      collection: "notes",
      operation: "read",
    },
    {
      method: "GET",
      path: "/rest/v1/orders",
      status: 401,
      durationMs: 2,
      role: "anon",
      collection: "orders",
      operation: "read",
      code: "CANOPY_UNAUTHORIZED",
    },
  ]
  for (let index = 0; index < 40; index += 1) {
    const shape = shapes[(index * 5) % shapes.length] as Omit<LogEntry, "at" | "requestId">
    entries.push({
      ...shape,
      at: new Date(now - index * 37_000).toISOString(),
      requestId: `req_${(9000 + index).toString(36)}`,
    })
  }
  return entries
}

/** App users of the built in auth. */
export function seedUsers(now: number): AppUser[] {
  return [
    {
      id: "u_alice",
      email: "alice@example.com",
      name: "Alice Martin",
      createdAt: new Date(now - 40 * day).toISOString(),
      lastSignInAt: new Date(now - 2 * 3_600_000).toISOString(),
      banned: false,
      roles: ["authenticated"],
      appMetadata: { org_ids: ["o1"] },
      userMetadata: { theme: "dark" },
      identities: [{ provider: "email", subject: "alice@example.com" }],
      sessions: [
        {
          id: "ses_1",
          createdAt: new Date(now - 3_600_000).toISOString(),
          userAgent: "Firefox 146",
        },
      ],
    },
    {
      id: "u_bob",
      email: "bob@example.com",
      name: "Bob Okafor",
      createdAt: new Date(now - 12 * day).toISOString(),
      lastSignInAt: new Date(now - day).toISOString(),
      banned: false,
      roles: ["authenticated"],
      appMetadata: { org_ids: ["o1", "o2"] },
      identities: [{ provider: "google", subject: "10931" }],
      sessions: [],
    },
    {
      id: "u_carol",
      email: "carol@example.com",
      name: "Carol Singh",
      createdAt: new Date(now - 3 * day).toISOString(),
      lastSignInAt: null,
      banned: true,
      roles: ["authenticated"],
      appMetadata: { org_ids: ["o2"] },
      identities: [{ provider: "email", subject: "carol@example.com" }],
      sessions: [],
    },
  ]
}
