import { Authenticator } from "@canopy/auth"
import { type ContextResolver, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import type { ReadPath, SchemaCache, WritePath } from "@canopy/rest"
import { describe, expect, it } from "vitest"
import { createGraphqlHandler, type GraphqlHandler } from "../src/index.ts"

const PUBLISHABLE = "canopy_pk_limits"

function handlerWith(
  options: { readonly maxBodyBytes?: number; readonly persisted?: Record<string, string> } = {},
): GraphqlHandler {
  const reads = {
    readLimits: { defaultLimit: 100, maxLimit: 1000, maxSkip: 10_000 },
    collections: async () => [],
  } as unknown as ReadPath
  return createGraphqlHandler({
    reads,
    writes: {} as WritePath,
    policies: new PolicyEngine(createPolicySet([collection("todos", { exposed: true })])),
    authenticator: new Authenticator(undefined, { publishable: [PUBLISHABLE] }),
    contexts: {} as ContextResolver,
    schemas: { all: async () => new Map(), version: 0 } as unknown as SchemaCache,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.persisted === undefined ? {} : { persisted: { operations: options.persisted } }),
  })
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://canopy.test/graphql/v1", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: PUBLISHABLE, ...headers },
    body,
  })
}

describe("request body limit", () => {
  it("refuses a body above the limit before parsing it, with 413", async () => {
    const handler = handlerWith({ maxBodyBytes: 1024 })
    const big = JSON.stringify({ query: `{ __typename ${" ".repeat(4096)} }` })
    const response = await handler.fetch(post(big))
    expect(response.status).toBe(413)
  })

  it("refuses an oversized body that does not declare its length", async () => {
    const handler = handlerWith({ maxBodyBytes: 1024 })
    const chunk = new TextEncoder().encode(" ".repeat(512))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) controller.close()
        else {
          sent += 1
          controller.enqueue(chunk)
        }
      },
    })
    const request = new Request("http://canopy.test/graphql/v1", {
      method: "POST",
      headers: { "content-type": "application/json", apikey: PUBLISHABLE },
      body: stream,
      duplex: "half",
    } as RequestInit)
    expect((await handler.fetch(request)).status).toBe(413)
  })

  it("still serves a body within the limit", async () => {
    const handler = handlerWith({ maxBodyBytes: 1024 })
    const response = await handler.fetch(post(JSON.stringify({ query: "{ __typename }" })))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { __typename: "Query" } })
  })

  it("defaults to 1 MiB", async () => {
    const handler = handlerWith()
    const big = JSON.stringify({ query: `{ __typename ${" ".repeat(1024 * 1024)} }` })
    expect((await handler.fetch(post(big))).status).toBe(413)
  })
})

describe("persisted operation lookup", () => {
  it("does not resolve inherited object properties as persisted hashes", async () => {
    const handler = handlerWith({ persisted: { abc: "{ __typename }" } })
    for (const hash of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const response = await handler.fetch(
        post(JSON.stringify({ extensions: { persistedQuery: { version: 1, sha256Hash: hash } } })),
      )
      const body = (await response.json()) as { errors?: { message: string }[] }
      expect(body.errors?.[0]?.message).toBe("PersistedQueryNotFound")
    }
  })
})
