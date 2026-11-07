import type { Binary, ObjectId } from "@canopy/protocol"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  allow,
  auth,
  type Claim,
  type Ctx,
  collection,
  createPolicyKit,
  ctx,
  now,
  restrict,
} from "../src/index.ts"

interface Task {
  _id: ObjectId
  projectId: ObjectId
  ownerId: ObjectId
  authorSub: string
  title: string
  status: "open" | "done"
  archived?: boolean
  internalNotes?: string
  tags: string[]
  dueAt?: Date
  meta?: { priority: number; reviewer?: { sub: string } }
}

interface Membership {
  _id: ObjectId
  userId: string
  projectId: ObjectId
  orgIds: string[]
}

interface Database {
  tasks: { Document: Task; Insert: Omit<Task, "_id"> & { _id?: ObjectId } }
  memberships: { Document: Membership; Insert: Membership }
}

interface Claims {
  sub: string
  email?: string
  org_ids: string[]
  app_metadata: { tenant_id: string }
  user_metadata: { nickname: string }
}

const base = createPolicyKit<{
  database: Database
  claims: Claims
  roles: "support" | "staff"
  context: Record<never, never>
}>()

const contexts = base.context({
  projectIds: {
    from: "memberships",
    where: { userId: base.auth("sub") },
    select: "projectId",
    max: 100,
    ttl: "PT1M",
  },
  orgIds: { from: "memberships", where: {}, select: "orgIds", max: 100, ttl: "PT1M" },
})

const kit = createPolicyKit<{
  database: Database
  claims: Claims
  roles: "support" | "staff"
  context: typeof contexts
}>()

/** Type checks run by `tsc -b`; this function is never called. */
function checks(): void {
  const { allow, restrict, auth, ctx, now, collection, context } = kit

  expectTypeOf(auth("sub")).toEqualTypeOf<Claim<string>>()
  expectTypeOf(auth("org_ids")).toEqualTypeOf<Claim<string[]>>()
  expectTypeOf(auth("app_metadata.tenant_id")).toEqualTypeOf<Claim<string>>()
  expectTypeOf(auth("sub", "objectId")).toEqualTypeOf<Claim<ObjectId>>()
  expectTypeOf(auth("org_ids", "objectId")).toEqualTypeOf<Claim<ObjectId[]>>()
  expectTypeOf(auth("sub", "uuid")).toEqualTypeOf<Claim<Binary>>()
  expectTypeOf(ctx("projectIds")).toEqualTypeOf<Ctx<ObjectId[]>>()
  expectTypeOf(ctx("orgIds")).toEqualTypeOf<Ctx<string[]>>()
  // @ts-expect-error unknown claim
  auth("su")
  // @ts-expect-error user_metadata is editable by users
  auth("user_metadata.nickname")
  // @ts-expect-error unknown coercion
  auth("sub", "int")
  // @ts-expect-error unknown context lookup
  ctx("projectId")

  allow.read("authenticated", "support", "staff", "anon", "public")
  // @ts-expect-error unknown role
  allow.read("suport")
  // @ts-expect-error service bypasses DLS and may never appear in a policy
  restrict.delete("service")

  collection("tasks", {
    exposed: true,
    realtime: true,
    policies: [
      allow.read("authenticated").where({ projectId: { $in: ctx("projectIds") } }),
      allow.read("authenticated").where({ ownerId: auth("sub", "objectId") }),
      allow.read("authenticated").where({ authorSub: auth("sub"), status: "open" }),
      allow.read("authenticated").where({ tags: auth("sub") }),
      allow.read("authenticated").where({ tags: { $in: auth("org_ids") } }),
      allow.read("authenticated").where({ "meta.reviewer.sub": auth("sub") }),
      allow.read("authenticated").where({ $or: [{ archived: false }, { "meta.priority": 1 }] }),
      allow.read("authenticated").where({ dueAt: { $gt: now("-P7D") } }),
      allow
        .update("authenticated")
        .where({ authorSub: auth("sub") })
        .check({ authorSub: auth("sub"), title: { $exists: true } })
        .named("edit own"),
      allow.read("support"),
      restrict.delete("authenticated").where({ archived: { $ne: true } }),
      { name: "raw", kind: "permissive", ops: ["read"], roles: ["staff"], using: { anything: 1 } },
    ],
    fields: {
      read: { default: { omit: ["internalNotes", "meta.reviewer"] }, staff: { only: ["*"] } },
      write: { default: { only: ["title", "status", "tags"] } },
    },
    immutable: ["ownerId", "projectId"],
  })

  collection("tasks", {
    // @ts-expect-error typo in a where field
    policies: [allow.read("authenticated").where({ ownreId: auth("sub", "objectId") })],
  })
  collection("tasks", {
    // @ts-expect-error a typo next to a valid field is still caught
    policies: [allow.read("authenticated").where({ authorSub: auth("sub"), titel: "x" })],
  })
  collection("tasks", {
    // @ts-expect-error a string claim against an ObjectId field never matches
    policies: [allow.update("authenticated").where({ ownerId: auth("sub") })],
  })
  collection("tasks", {
    // @ts-expect-error a list claim against a scalar field
    policies: [allow.read("authenticated").where({ authorSub: auth("org_ids") })],
  })
  collection("tasks", {
    // @ts-expect-error a scalar claim where $in needs a list
    policies: [allow.read("authenticated").where({ authorSub: { $in: auth("sub") } })],
  })
  collection("tasks", {
    // @ts-expect-error a context lookup resolves to a list, so it only fits $in, $nin and $all
    policies: [allow.read("authenticated").where({ projectId: ctx("projectIds") })],
  })
  collection("tasks", {
    // @ts-expect-error the lookup selects ObjectIds, the field holds strings
    policies: [allow.read("authenticated").where({ authorSub: { $in: ctx("projectIds") } })],
  })
  collection("tasks", {
    // @ts-expect-error wrong literal for a literal union field
    policies: [allow.read("authenticated").where({ status: "closed" })],
  })
  collection("tasks", {
    policies: [
      // @ts-expect-error typo inside $or
      allow.read("authenticated").where({ $or: [{ archived: false }, { archivd: true }] }),
    ],
  })
  collection("tasks", {
    // @ts-expect-error typo in a check clause
    policies: [allow.insert("authenticated").check({ authorSub: auth("sub"), tilte: "x" })],
  })
  collection("tasks", {
    // @ts-expect-error unknown nested field
    policies: [allow.read("authenticated").where({ "meta.priorty": 1 })],
  })
  collection("tasks", {
    // @ts-expect-error a date field compared with a string
    policies: [allow.read("authenticated").where({ dueAt: { $gt: "yesterday" } })],
  })
  // @ts-expect-error unknown collection
  collection("task", {})
  collection("tasks", {
    // @ts-expect-error a typo in an omit list would leak the field
    fields: { read: { default: { omit: ["internalNote"] } } },
  })
  collection("tasks", {
    // @ts-expect-error a typo in an only list
    fields: { write: { default: { only: ["titel"] } } },
  })
  collection("tasks", {
    // @ts-expect-error field rules for an unknown role
    fields: { read: { suport: { omit: ["internalNotes"] } } },
  })
  // @ts-expect-error typo in immutable
  collection("tasks", { immutable: ["ownerID"] })

  context({
    // @ts-expect-error unknown collection in from
    a: { from: "membership", where: {}, select: "projectId", max: 1, ttl: "PT1M" },
  })
  context({
    // @ts-expect-error unknown select field
    a: { from: "memberships", where: {}, select: "project", max: 1, ttl: "PT1M" },
  })
  context({
    // @ts-expect-error typo in a lookup's where clause
    a: {
      from: "memberships",
      where: { usrId: auth("sub") },
      select: "projectId",
      max: 1,
      ttl: "PT1M",
    },
  })
}

/** The default exports stay untyped without a `Register` declaration. */
function untypedChecks(): void {
  expectTypeOf(auth("anything.at.all")).toEqualTypeOf<Claim<never>>()
  expectTypeOf(ctx("whatever")).toEqualTypeOf<Ctx<never>>()
  collection("any_collection", {
    exposed: true,
    policies: [
      allow.read("any-role").where({ any: auth("sub"), list: { $in: ctx("x") } }),
      restrict.update("authenticated").check({ when: { $lt: now() } }),
    ],
    fields: { read: { default: { omit: ["whatever"] }, custom: { only: ["*"] } } },
    immutable: ["anything"],
  })
}

describe("typed policies", () => {
  it("are checked by the compiler", () => {
    expectTypeOf(checks).toBeFunction()
    expectTypeOf(untypedChecks).toBeFunction()
  })

  it("produce the same JSON as the untyped DSL", () => {
    const typed = kit.collection("tasks", {
      exposed: true,
      policies: [
        kit.allow.read("authenticated").where({ projectId: { $in: kit.ctx("projectIds") } }),
        kit.allow
          .update("staff")
          .where({ ownerId: kit.auth("sub", "objectId") })
          .check({ dueAt: { $gt: kit.now("-P1D") } })
          .named("staff edits"),
        kit.restrict.delete("authenticated").where({ archived: { $ne: true } }),
      ],
      fields: { read: { default: { omit: ["internalNotes"] } } },
      immutable: ["ownerId"],
    })
    const untyped = collection("tasks", {
      exposed: true,
      policies: [
        allow.read("authenticated").where({ projectId: { $in: ctx("projectIds") } }),
        allow
          .update("staff")
          .where({ ownerId: auth("sub", "objectId") })
          .check({ dueAt: { $gt: now("-P1D") } })
          .named("staff edits"),
        restrict.delete("authenticated").where({ archived: { $ne: true } }),
      ],
      fields: { read: { default: { omit: ["internalNotes"] } } },
      immutable: ["ownerId"],
    })
    expect(JSON.stringify(typed)).toBe(JSON.stringify(untyped))
    expect(typed).toEqual({
      collection: "tasks",
      exposed: true,
      realtime: false,
      policies: [
        {
          name: "permissive read #1",
          kind: "permissive",
          ops: ["read"],
          roles: ["authenticated"],
          using: { projectId: { $in: { $ctx: "projectIds" } } },
        },
        {
          name: "staff edits",
          kind: "permissive",
          ops: ["update"],
          roles: ["staff"],
          using: { ownerId: { $auth: "sub", as: "objectId" } },
          check: { dueAt: { $gt: { $now: { offset: "-P1D" } } } },
        },
        {
          name: "restrictive delete #3",
          kind: "restrictive",
          ops: ["delete"],
          roles: ["authenticated"],
          using: { archived: { $ne: true } },
        },
      ],
      fields: { read: { default: { omit: ["internalNotes"] } } },
      immutable: ["ownerId"],
    })
    expect(contexts).toEqual({
      projectIds: {
        from: "memberships",
        where: { userId: { $auth: "sub" } },
        select: "projectId",
        max: 100,
        ttl: "PT1M",
      },
      orgIds: { from: "memberships", where: {}, select: "orgIds", max: 100, ttl: "PT1M" },
    })
  })
})
