import {
  allow,
  auth,
  type CollectionPolicies,
  collection,
  restrict,
  toStored,
} from "@canopy/policy"
import type { JWK } from "jose"
import { BSON } from "mongodb"
import { buildFixture as buildFindFixture } from "../find/fixture.ts"
import type { Fixture } from "../find/harness.ts"

/** How a collection of the writes fixture is created before its documents are inserted. */
interface CollectionSetup {
  /** `createCollection` options: a validator or a default collation. */
  readonly options?: Readonly<Record<string, unknown>>
  /** Indexes besides `_id`, as `createIndex` takes them. */
  readonly indexes?: readonly {
    readonly key: Readonly<Record<string, number>>
    readonly name: string
    readonly unique?: boolean
  }[]
}

/** The fixture of the writes oracle: the find fixture's callers and keys, with collections made for writes. */
export interface WritesFixture extends Fixture {
  /** Collection options and indexes, created before the documents of each case are inserted. */
  readonly setup: Readonly<Record<string, CollectionSetup>>
}

type Doc = Record<string, unknown>

const date = (iso: string): Date => new Date(iso)

function canonical(documents: readonly Doc[]): unknown[] {
  return documents.map(
    (doc) => JSON.parse(BSON.EJSON.stringify(doc, { relaxed: false })) as unknown,
  )
}

function notes(): Doc[] {
  return [1, 2, 3, 4, 5, 6].map((n) => ({
    _id: `n${n}`,
    ownerId: n <= 4 ? "alice" : "bob",
    title: `note ${n}`,
    done: n % 2 === 0,
    n: new BSON.Int32(n),
    tags: n % 3 === 0 ? ["a", "b"] : ["a"],
    createdAt: date(`2026-01-0${n}T00:00:00Z`),
    secret: `secret-${n}`,
  }))
}

function posts(): Doc[] {
  return [
    { _id: "p1", status: "draft", title: "one", authorId: "alice" },
    { _id: "p2", status: "published", title: "two", authorId: "bob" },
    { _id: "p3", status: "draft", title: "three", authorId: "alice" },
    { _id: "p4", status: "published", title: "four", authorId: "alice", locked: true },
  ]
}

function authored(): CollectionPolicies[] {
  return [
    collection("notes", {
      exposed: true,
      policies: [
        allow.read("authenticated").where({ ownerId: auth("sub") }),
        allow.insert("authenticated").check({ ownerId: auth("sub") }),
        allow
          .update("authenticated")
          .where({ ownerId: auth("sub") })
          .check({ ownerId: auth("sub") }),
        allow.delete("authenticated").where({ ownerId: auth("sub") }),
        allow.read("admin"),
        allow.update("admin"),
        allow.delete("admin"),
      ],
      fields: {
        read: { default: { omit: ["secret"] } },
        write: { default: { omit: ["secret", "n"] }, admin: { omit: ["secret"] } },
      },
      immutable: ["createdAt"],
    }),
    collection("posts", {
      exposed: true,
      policies: [
        allow.read("public"),
        allow.insert("authenticated").check({ status: { $in: ["draft", "published"] } }),
        allow.update("authenticated").check({ status: { $in: ["draft", "published"] } }),
        restrict.update("authenticated").where({ locked: { $ne: true } }),
        allow.delete("admin"),
      ],
    }),
    collection("frozen", {
      exposed: true,
      policies: [allow.read("authenticated"), allow.update("authenticated")],
      immutable: ["kind"],
    }),
    collection("counters", {
      exposed: true,
      policies: [
        allow.read("authenticated"),
        allow.insert("authenticated"),
        allow.update("authenticated"),
        allow.delete("authenticated"),
      ],
    }),
    collection("people", {
      exposed: true,
      policies: [
        allow.read("authenticated"),
        allow.insert("authenticated"),
        allow.update("authenticated"),
      ],
    }),
    collection("folded", {
      exposed: true,
      policies: [
        allow.read("authenticated"),
        allow.insert("authenticated"),
        allow.update("authenticated"),
        allow.delete("authenticated"),
      ],
    }),
    collection("inbox", {
      exposed: true,
      policies: [allow.insert("authenticated")],
    }),
    collection("hidden", {
      exposed: false,
      policies: [allow.read("authenticated"), allow.insert("authenticated")],
    }),
  ]
}

/**
 * Builds the fixture of the writes oracle: the callers, keys and signing key of the find fixture, and
 * collections whose policies, field rules, immutable fields, validator, unique index and collation reach
 * every refusal of the write path.
 */
export async function buildWritesFixture(): Promise<WritesFixture> {
  const find = await buildFindFixture()
  const definitions = authored()
  const order: readonly (keyof JWK)[] = ["kty", "crv", "x", "kid", "alg", "use"]
  const keys = find.auth.jwks.keys.map(
    (key) =>
      Object.fromEntries(order.flatMap((name) => (name in key ? [[name, key[name]]] : []))) as JWK,
  )
  return {
    ...find,
    auth: { ...find.auth, jwks: { keys } },
    name: "writes",
    idTypes: { counters: "number" },
    collections: {
      notes: canonical(notes()),
      posts: canonical(posts()),
      counters: canonical([
        { _id: 1, n: new BSON.Int32(1) },
        { _id: 2, n: new BSON.Int32(2) },
      ]),
      people: canonical([
        { _id: "u1", email: "ann@example.test" },
        { _id: "u2", email: "ben@example.test" },
      ]),
      folded: canonical([{ _id: "Key", v: 1 }]),
      frozen: canonical([{ _id: "f1", kind: "a", v: 1 }]),
      inbox: [],
      hidden: canonical([{ _id: "h1" }]),
    },
    setup: {
      counters: {
        options: {
          validator: {
            $jsonSchema: {
              bsonType: "object",
              required: ["n"],
              properties: { n: { bsonType: "int" } },
            },
          },
        },
      },
      people: { indexes: [{ key: { email: 1 }, name: "email_unique", unique: true }] },
      folded: { options: { collation: { locale: "en", strength: 2 } } },
    },
    policies: {
      collections: definitions.map((def) => toStored(def, { version: 1 })),
      contexts: {},
    },
  }
}
