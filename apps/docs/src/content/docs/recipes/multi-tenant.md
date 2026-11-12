---
title: Multi tenant apps
description: Isolate tenants with policies, context lookups and roles.
---

Store a tenant id on every tenant owned document and let policies, not app code, enforce the boundary. Two
common shapes:

## The tenant is a token claim

When users belong to one tenant at a time, put its id in a claim (with built in auth, from a claims hook):

```ts
// canopy/policies/projects.ts
import { allow, auth, collection } from "@canopy/policy"

const sameTenant = { tenantId: auth("tenant_id") }

export default collection("projects", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where(sameTenant),
    allow.insert("member").check(sameTenant),
    allow.update("member").where(sameTenant).check(sameTenant),
    allow.delete("tenant_admin").where(sameTenant),
  ],
  immutable: ["tenantId"],
})
```

`immutable` stops a document from being moved to another tenant, and the `check` clause stops one from being
created in another tenant. A token without `tenant_id` sees nothing.

## Users in many tenants

When a user can belong to several tenants, read the memberships with a context lookup:

```ts
// canopy/policies/_context.ts
import { auth, context } from "@canopy/policy"

export default context({
  tenantIds: {
    from: "memberships",
    where: { userId: auth("sub") },
    select: "tenantId",
    max: 200,
    ttl: "1m",
  },
  adminOf: {
    from: "memberships",
    where: { userId: auth("sub"), role: "admin" },
    select: "tenantId",
    max: 200,
    ttl: "1m",
  },
})
```

```ts
import { allow, collection, ctx } from "@canopy/policy"

export default collection("projects", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ tenantId: { $in: ctx("tenantIds") } }),
    allow
      .update("authenticated")
      .where({ tenantId: { $in: ctx("tenantIds") } })
      .check({ tenantId: { $in: ctx("tenantIds") } }),
    allow.delete("authenticated").where({ tenantId: { $in: ctx("adminOf") } }),
  ],
})
```

Lookups are cached for their `ttl` and recomputed when the documents they read change, so removing a
membership revokes access on open live queries too. `max` bounds the list; a user above it is denied rather
than given a truncated list.

## Testing the boundary

```ts
import { as, describePolicies } from "@canopy/policy/testing"

describePolicies("projects", ({ doc, expect }) => {
  const project = doc({ _id: "p1", tenantId: "t1", name: "Apollo" })
  expect(as.user({ sub: "u1" }, { ctx: { tenantIds: ["t1"] } })).can.read(project)
  expect(as.user({ sub: "u2" }, { ctx: { tenantIds: ["t2"] } })).cannot.read(project)
})
```

Add an index on `tenantId` (or a compound index starting with it) to every tenant scoped collection.
`canopy indexes advise` lists the ones your policies need.
