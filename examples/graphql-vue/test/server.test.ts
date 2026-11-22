import type { AddressInfo } from "node:net"
import { MONGODB_URI } from "@canopy/testing"
import { createAuth } from "canopy.js/auth"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BoardServer, createBoardServer } from "../src/app.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_board_test"

interface GraphqlAnswer {
  readonly data?: Record<string, unknown> | null
  readonly errors?: readonly { readonly message: string; readonly extensions?: { code?: string } }[]
}

suite("graphql-vue server", () => {
  const database = `board_test_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let board: BoardServer
  let base: string
  let address = 0

  /** Signs a new anonymous user in, from a client address of their own. */
  const visitor = async (): Promise<{ id: string; token: string }> => {
    address++
    const forwarded = `10.8.0.${address}`
    const auth = createAuth({
      url: base,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set("x-forwarded-for", forwarded)
        return fetch(input, { ...init, headers })
      },
    })
    const user = await auth.signInAnonymously()
    const token = await auth.getToken()
    if (token === null) throw new Error("expected a token after an anonymous sign in")
    return { id: user.id, token }
  }

  const graphql = async (
    token: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GraphqlAnswer> => {
    const response = await fetch(`${base}/graphql/v1`, {
      method: "POST",
      headers: {
        apikey: KEY,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    })
    return (await response.json()) as GraphqlAnswer
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    board = await createBoardServer({
      mongoUri: MONGODB_URI ?? "",
      database,
      publicUrl: "http://127.0.0.1",
      publishableKey: KEY,
      masterKey: "b".repeat(48),
      conditions: ["@canopy/source"],
    })
    await new Promise<void>((resolve) => board.server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(board.server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await board?.close()
    for (const suffix of ["", "_meta", "_auth"])
      await mongo.db(`${database}${suffix}`).dropDatabase()
    await mongo.close()
  })

  it("lists the topics and resolves a post's topic through the relation", async () => {
    const ann = await visitor()
    const topics = await graphql(
      ann.token,
      "{ topics(sort: [{ field: name, direction: ASC }]) { nodes { _id name } } }",
    )
    expect(topics.errors).toBeUndefined()
    expect(topics.data).toEqual({
      topics: {
        nodes: [
          { _id: "help", name: "Help" },
          { _id: "ideas", name: "Ideas" },
          { _id: "news", name: "News" },
        ],
      },
    })
    const created = await graphql(
      ann.token,
      'mutation ($ownerId: String!) { insertPost(doc: { title: "Hello", topicId: "ideas", ownerId: $ownerId }) { _id } }',
      { ownerId: ann.id },
    )
    expect(created.errors).toBeUndefined()
    const ben = await visitor()
    const read = await graphql(ben.token, "{ posts { nodes { title ownerId topic { name } } } }")
    expect(read.data).toEqual({
      posts: { nodes: [{ title: "Hello", ownerId: ann.id, topic: { name: "Ideas" } }] },
    })
  })

  it("refuses a post for someone else and an unknown field, and deletes only own posts", async () => {
    const ann = await visitor()
    const ben = await visitor()
    const forged = await graphql(
      ben.token,
      'mutation ($ownerId: String!) { insertPost(doc: { title: "Mine now", topicId: "news", ownerId: $ownerId }) { _id } }',
      { ownerId: ann.id },
    )
    expect(forged.errors?.[0]?.extensions?.code).toBe("CANOPY_POLICY_VIOLATION")
    const extra = await graphql(
      ben.token,
      'mutation ($ownerId: String!) { insertPost(doc: { title: "x", topicId: "news", ownerId: $ownerId, pinned: true }) { _id } }',
      { ownerId: ben.id },
    )
    expect(extra.errors?.length ?? 0).toBeGreaterThan(0)

    const created = await graphql(
      ann.token,
      'mutation ($ownerId: String!) { insertPost(doc: { title: "Ann\'s", topicId: "help", ownerId: $ownerId }) { _id } }',
      { ownerId: ann.id },
    )
    const id = (created.data?.["insertPost"] as { _id: string } | undefined)?._id
    expect(id).toMatch(/^[0-9a-f]{24}$/)
    const removed = await graphql(
      ben.token,
      "mutation ($id: ObjectId!) { deletePost(id: $id) { _id } }",
      { id },
    )
    expect(removed).toEqual({ data: { deletePost: null } })
    expect(await mongo.db(database).collection("posts").countDocuments({ title: "Ann's" })).toBe(1)
    const own = await graphql(
      ann.token,
      "mutation ($id: ObjectId!) { deletePost(id: $id) { _id } }",
      {
        id,
      },
    )
    expect(own).toEqual({ data: { deletePost: { _id: id } } })
    expect(await mongo.db(database).collection("posts").countDocuments({ title: "Ann's" })).toBe(0)
    expect(await mongo.db(database).collection("posts").countDocuments({ title: "Mine now" })).toBe(
      0,
    )
  })
})
