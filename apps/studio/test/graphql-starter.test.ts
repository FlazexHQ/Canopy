import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import {
  initialOperation,
  rootFields,
  starterOperation,
} from "../src/features/api/graphql-starter.ts"

const schema = buildSchema(`
  scalar ObjectId
  type Query {
    todos(limit: Int = 100, after: String): TodoConnection!
    todo(id: ObjectId!): Todo
    todosCount: Int!
  }
  type Mutation { deleteTodo(id: ObjectId!, where: String): Todo }
  type TodoConnection { nodes: [Todo!]! next: String }
  type Todo { _id: ObjectId! title: String owner: User tags: [String] }
  type User { name: String }
`)

describe("GraphQL starter operations", () => {
  it("lists root fields with their signatures", () => {
    expect(rootFields(schema).map((field) => `${field.kind} ${field.signature}`)).toEqual([
      "query todos(limit: Int, after: String): TodoConnection!",
      "query todo(id: ObjectId!): Todo",
      "query todosCount: Int!",
      "mutation deleteTodo(id: ObjectId!, where: String): Todo",
    ])
  })

  it("selects a connection's nodes and scalar fields with a limit", () => {
    expect(starterOperation(schema, "query", "todos")).toBe(
      "query {\n  todos(limit: 10) {\n    nodes {\n      _id\n      title\n      tags\n    }\n    next\n  }\n}\n",
    )
  })

  it("turns required arguments into variables", () => {
    expect(starterOperation(schema, "mutation", "deleteTodo")).toBe(
      "mutation($id: ObjectId!) {\n  deleteTodo(id: $id) {\n    _id\n    title\n    tags\n  }\n}\n",
    )
    expect(starterOperation(schema, "query", "todosCount")).toBe("query {\n  todosCount\n}\n")
    expect(starterOperation(schema, "query", "missing")).toBe("query {\n  __typename\n}")
  })

  it("starts from the first query", () => {
    expect(initialOperation(schema)).toBe(starterOperation(schema, "query", "todos"))
    expect(initialOperation(buildSchema("type Query { _empty: Boolean }"))).toBe(
      "query {\n  __typename\n}\n",
    )
  })
})
