import { allow, auth, collection, toStored } from "@canopy/policy"
import { sha256Hex } from "@canopy/protocol"
import type { JWK } from "jose"
import { BSON } from "mongodb"
import { buildFixture as buildFindFixture } from "../../../rest/test/conformance/find/fixture.ts"
import type { Fixture } from "../../../rest/test/conformance/find/harness.ts"
import type { GraphqlHandlerOptions } from "../../src/handler.ts"
import type { OperationLimits } from "../../src/limits.ts"

const PERSISTED_QUERY = "{ todosCount }"
export const PERSISTED_HASH = sha256Hex(PERSISTED_QUERY)
export const MAX_BODY_BYTES = 1024

export const TODO_IDS = [
  "600000000000000000000001",
  "600000000000000000000002",
  "600000000000000000000003",
  "600000000000000000000004",
  "600000000000000000000005",
  "600000000000000000000006",
] as const

/** The app documents, policies, callers and GraphQL settings shared by the cases. */
export interface GraphqlFixture extends Fixture {
  readonly limits: OperationLimits
  readonly maxBatch: number
  readonly maxBodyBytes: number
  readonly introspection: NonNullable<GraphqlHandlerOptions["introspection"]>
  readonly persisted: NonNullable<GraphqlHandlerOptions["persisted"]>
  readonly relations: NonNullable<GraphqlHandlerOptions["collections"]>
}

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

const users = collection("users", { exposed: true, policies: [allow.read("authenticated")] })
const notices = collection("notices", { exposed: true, policies: [allow.read("public")] })

function canonical(documents: readonly Record<string, unknown>[]): unknown[] {
  return documents.map(
    (doc) => JSON.parse(BSON.EJSON.stringify(doc, { relaxed: false })) as unknown,
  )
}

/** Builds the GraphQL fixture with the signing key and callers of the find oracle. */
export async function buildGraphqlFixture(): Promise<GraphqlFixture> {
  const find = await buildFindFixture()
  const order: readonly (keyof JWK)[] = ["kty", "crv", "x", "kid", "alg", "use"]
  const keys = find.auth.jwks.keys.map(
    (key) =>
      Object.fromEntries(order.flatMap((name) => (name in key ? [[name, key[name]]] : []))) as JWK,
  )
  return {
    ...find,
    name: "graphql",
    basePath: "/graphql/v1",
    auth: { ...find.auth, jwks: { keys } },
    collections: {
      todos: canonical(
        TODO_IDS.map((id, index) => ({
          _id: new BSON.ObjectId(id),
          ownerId: index < 4 ? "alice" : "bob",
          title: `todo ${index + 1}`,
          priority: new BSON.Int32(index + 1),
          estimate: new BSON.Double(index + 0.5),
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
          tags: index % 2 === 0 ? ["work", "urgent"] : ["home"],
          detail: { note: `note ${index + 1}` },
          secret: `secret ${index + 1}`,
        })),
      ),
      users: canonical([
        { _id: "alice", name: "Alice" },
        { _id: "bob", name: "Bob" },
      ]),
      notices: canonical([{ _id: "welcome", title: "Welcome" }]),
      staff: find.collections["staff"] ?? [],
      tasks: find.collections["tasks"] ?? [],
      memberships: find.collections["memberships"] ?? [],
      hidden: find.collections["hidden"] ?? [],
    },
    policies: {
      collections: [
        ...[todos, users, notices].map((definition) => toStored(definition, { version: 1 })),
        ...find.policies.collections.filter((doc) =>
          ["staff", "tasks", "hidden"].includes((doc as { _id: string })._id),
        ),
      ],
      contexts: find.policies.contexts,
    },
    relations: { todos: { relations: { owner: { to: "users", local: "ownerId" } } } },
    limits: { maxDepth: 3, maxAliases: 3, maxComplexity: 10 },
    maxBatch: 2,
    maxBodyBytes: MAX_BODY_BYTES,
    introspection: "authenticated",
    persisted: { operations: { [PERSISTED_HASH]: PERSISTED_QUERY } },
  }
}
