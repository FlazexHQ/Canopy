import { allow, auth, collection, createPolicySet, type RequestContext } from "@canopy/policy"
import { ObjectId } from "@canopy/protocol"
import type { FindRequest, WriteRequest, WriteResult } from "@canopy/rest"
import type { CollectionSchema, ObjectShape, ScalarType, Shape } from "@canopy/schema"
import { testPolicyEngine } from "@canopy/testing"
import { type GraphQLObjectType, type GraphQLSchema, graphql, printSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { buildSchema, type RelationSpec, type RequestServices } from "../src/index.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["internalNotes"] } } },
})
const users = collection("users", {
  exposed: true,
  policies: [allow.read("authenticated")],
})
const audit = collection("audit", { exposed: true, policies: [allow.read("auditor")] })

const engine = testPolicyEngine(createPolicySet([todos, users, audit]))

const scalar = (type: ScalarType): Shape => ({ kind: "scalar", type })
const shape = (
  fields: Record<string, [ObjectShape["fields"][string]["shape"], boolean]>,
): ObjectShape => ({
  kind: "object",
  open: false,
  fields: Object.fromEntries(
    Object.entries(fields).map(([name, [field, required]]) => [name, { shape: field, required }]),
  ),
})

const schemas = new Map<string, CollectionSchema>([
  [
    "todos",
    {
      name: "todos",
      source: "validator",
      shape: shape({
        _id: [scalar("objectId"), true],
        title: [scalar("string"), true],
        status: [scalar("string"), false],
        priority: [scalar("int"), false],
        score: [{ kind: "union", of: [scalar("int"), scalar("double")] }, false],
        createdAt: [scalar("date"), false],
        tags: [{ kind: "array", items: scalar("string") }, false],
        meta: [shape({ color: [scalar("string"), false] }), false],
        ownerId: [scalar("string"), true],
        "due-date": [scalar("date"), false],
        internalNotes: [scalar("string"), false],
      }),
    },
  ],
  [
    "users",
    {
      name: "users",
      source: "inferred",
      shape: shape({ _id: [scalar("string"), true], name: [scalar("string"), true] }),
    },
  ],
])

const alice: RequestContext = {
  roles: new Set(["authenticated"]),
  claims: { sub: "alice" },
  now: new Date(),
}
const anon: RequestContext = { roles: new Set(["anon"]), claims: null, now: new Date() }

function schemaFor(ctx: RequestContext, subscriptions = true): GraphQLSchema {
  return buildSchema({
    engine,
    ctx,
    collections: ["audit", "todos", "users"],
    schemas,
    subscriptions,
    config: {
      todos: { relations: { owner: { to: "users", local: "ownerId" } } },
      users: {
        relations: { todos: { to: "todos", local: "_id", foreign: "ownerId", many: true } },
      },
    },
  })
}

const result = (overrides: Partial<WriteResult> = {}): WriteResult => ({
  matched: 1,
  modified: 1,
  deleted: 0,
  insertedIds: [],
  changedIds: [],
  ct: "7",
  replayed: false,
  ...overrides,
})

function fake() {
  const finds: FindRequest[] = []
  const writes: WriteRequest[] = []
  const related: [RelationSpec, unknown, number][] = []
  const services: RequestServices = {
    async find(request) {
      finds.push(request)
      return {
        docs: [
          {
            _id: new ObjectId("64a1b2c3d4e5f6a7b8c9d0e1"),
            title: "a",
            ownerId: "alice",
            "due-date": new Date(0),
          },
        ],
        limit: request.limit ?? 100,
        next: "cursor",
        ct: "42",
        ...(request.count === undefined ? {} : { total: 9 }),
      }
    },
    async findById(_collection, id) {
      return { _id: id, title: "one" }
    },
    async count() {
      return 3
    },
    async write(request) {
      writes.push(request)
      return result({ documents: [{ _id: "new", title: "written" }] })
    },
    async related(spec, key, limit) {
      related.push([spec, key, limit])
      return spec.many ? [{ _id: "t1", title: "theirs" }] : [{ _id: key, name: "Alice" }]
    },
  }
  return { services, finds, writes, related }
}

describe("generated schema", () => {
  it("describes only what the role set may read and write", () => {
    const sdl = printSchema(schemaFor(alice))
    expect(sdl).toContain("type Todo {")
    expect(sdl).toContain("type User {")
    expect(sdl).not.toContain("type Audit")
    const todoType = sdl.slice(
      sdl.indexOf("type Todo {"),
      sdl.indexOf("}", sdl.indexOf("type Todo {")),
    )
    expect(todoType).toContain("title: String")
    expect(todoType).not.toContain("internalNotes")
    expect(sdl).toContain("due_date: DateTime")
    expect(sdl).toContain("meta: TodoMeta")
    expect(sdl).toContain("score: Float")
    expect(sdl).toContain(
      "todos(filter: TodoFilter, sort: [TodoSort!], limit: Int = 100, after: String, skip: Int): TodoConnection!",
    )
    expect(sdl).toContain("todo(id: ObjectId!): Todo")
    expect(sdl).toContain("insertTodo(doc: TodoInsert!): Todo")
    expect(sdl).toContain("updateTodos(filter: TodoFilter!, update: TodoUpdate!): BulkResult!")
    expect(sdl).not.toContain("deleteTodo")
    expect(sdl).not.toContain("insertUser")
    expect(sdl).toContain(
      "liveTodos(filter: TodoFilter, sort: [TodoSort!], limit: Int = 100): [Todo!]!",
    )
    expect(sdl).toContain("todoChanges(")
    expect(sdl).not.toContain("liveUsers")
    expect(sdl).toContain("owner: User")
    expect(sdl).toContain("todos(limit: Int = 100): [Todo!]!")
  })

  it("requires the fields a validator requires on insert, except _id", () => {
    const insert = schemaFor(alice).getType("TodoInsert") as unknown as GraphQLObjectType
    const fields = insert.getFields()
    expect(String(fields["title"]?.type)).toBe("String!")
    expect(String(fields["status"]?.type)).toBe("String")
    expect(String(fields["_id"]?.type)).toBe("ObjectId")
    expect(fields["internalNotes"]).toBeDefined()
  })

  it("gives anon an empty schema when it may read nothing", () => {
    const sdl = printSchema(schemaFor(anon))
    expect(sdl).toContain("_empty: Boolean")
    expect(sdl).not.toContain("type Todo")
    expect(sdl).not.toContain("type Mutation")
  })

  it("leaves subscriptions out without realtime", () => {
    expect(schemaFor(alice, false).getSubscriptionType()).toBeUndefined()
  })
})

describe("resolvers", () => {
  const schema = schemaFor(alice)

  it("translates list arguments into a find request", async () => {
    const { services, finds } = fake()
    const response = await graphql({
      schema,
      contextValue: { canopy: services },
      source: `{
        todos(
          filter: { status: { in: ["active", "waiting"] }, due_date: { lt: "2026-01-01T00:00:00Z" }, raw: { tags: "x" } }
          sort: [{ field: due_date, direction: DESC }, { field: title }]
          limit: 5000
          after: "abc"
        ) { nodes { _id title due_date } next ct }
      }`,
    })
    expect(response.errors).toBeUndefined()
    expect(finds).toEqual([
      {
        collection: "todos",
        filter: {
          $and: [
            {
              status: { $in: ["active", "waiting"] },
              "due-date": { $lt: new Date("2026-01-01T00:00:00Z") },
            },
            { tags: "x" },
          ],
        },
        sort: { "due-date": -1, title: 1 },
        limit: 1000,
        after: "abc",
      },
    ])
    expect(response.data).toEqual({
      todos: {
        nodes: [
          { _id: "64a1b2c3d4e5f6a7b8c9d0e1", title: "a", due_date: "1970-01-01T00:00:00.000Z" },
        ],
        next: "cursor",
        ct: "42",
      },
    })
  })

  it("counts only when total is selected", async () => {
    const { services, finds } = fake()
    const response = await graphql({
      schema,
      contextValue: { canopy: services },
      source:
        "{ todos { total } again: todos { ct } todosCount(filter: { priority: { gte: 1 } }) }",
    })
    expect(response.errors).toBeUndefined()
    expect(finds.map((request) => request.count)).toEqual(["exact", undefined])
    expect(response.data).toEqual({ todos: { total: 9 }, again: { ct: "42" }, todosCount: 3 })
  })

  it("translates update inputs and returns the written document", async () => {
    const { services, writes } = fake()
    const response = await graphql({
      schema,
      contextValue: { canopy: services },
      source: `mutation Update($raw: JSON) {
        updateTodo(
          id: "64a1b2c3d4e5f6a7b8c9d0e1"
          update: { set: { status: "done", due_date: 0 }, inc: { priority: 2 }, unset: [tags], raw: $raw }
          where: { status: { eq: "active" } }
        ) { title }
      }`,
      variableValues: { raw: { $push: { log: "x" } } },
    })
    expect(response.errors).toBeUndefined()
    expect(writes).toEqual([
      {
        op: "update",
        collection: "todos",
        id: new ObjectId("64a1b2c3d4e5f6a7b8c9d0e1"),
        update: {
          $set: { status: "done", "due-date": new Date(0) },
          $inc: { priority: 2 },
          $unset: { tags: "" },
          $push: { log: "x" },
        },
        where: { status: { $eq: "active" } },
      },
    ])
    expect(response.data).toEqual({ updateTodo: { title: "written" } })
  })

  it("rejects an insert that misses a required field before it reaches the write path", async () => {
    const { services, writes } = fake()
    const response = await graphql({
      schema,
      contextValue: { canopy: services },
      source: 'mutation { insertTodo(doc: { ownerId: "alice" }) { _id } }',
    })
    expect(response.errors?.[0]?.message).toContain("title")
    expect(writes).toEqual([])
  })

  it("resolves relations through the batched loader", async () => {
    const { services, related } = fake()
    const response = await graphql({
      schema,
      contextValue: { canopy: services },
      source: "{ todos { nodes { owner { name todos(limit: 3) { title } } } } }",
    })
    expect(response.errors).toBeUndefined()
    expect(related).toEqual([
      [{ key: "todos.owner", to: "users", foreign: "_id", many: false }, "alice", 1],
      [{ key: "users.todos", to: "todos", foreign: "ownerId", many: true }, "alice", 3],
    ])
    expect(response.data).toEqual({
      todos: { nodes: [{ owner: { name: "Alice", todos: [{ title: "theirs" }] } }] },
    })
  })
})
