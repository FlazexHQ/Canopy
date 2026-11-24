import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { Authenticator } from "@canopy/auth"
import { type CollectionGraphqlConfig, createGraphqlHandler } from "@canopy/graphql"
import { toNodeListener } from "@canopy/node-http"
import {
  ContextResolver,
  contextsFromStored,
  createPolicySet,
  fromStored,
  PolicyEngine,
} from "@canopy/policy"
import { createRestHandler, mongoContextReader, SchemaCache } from "@canopy/rest"
import { MongoClient } from "mongodb"

interface Setup {
  readonly uri: string
  readonly database: string
  readonly metaDatabase: string
  readonly issuer: string
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] }
  readonly publishable: readonly string[]
  readonly secret: readonly string[]
  readonly stored: readonly unknown[]
  readonly collections: Readonly<Record<string, CollectionGraphqlConfig>>
  readonly contexts: unknown
}

const line = await new Promise<string>((resolve) => {
  const reader = createInterface({ input: process.stdin })
  reader.once("line", (text) => {
    reader.close()
    resolve(text)
  })
})
const setup = JSON.parse(line) as Setup
const client = new MongoClient(setup.uri)
await client.connect()
const set = createPolicySet(
  setup.stored.map((stored) => fromStored(stored)),
  contextsFromStored(setup.contexts),
)
const db = client.db(setup.database)
const policies = new PolicyEngine(set)
const contexts = new ContextResolver({ reader: mongoContextReader(db) })
const authenticator = new Authenticator(
  { jwks: { keys: [...setup.jwks.keys] }, issuer: setup.issuer },
  { publishable: [...setup.publishable], secret: [...setup.secret] },
)
const rest = createRestHandler({
  client,
  database: setup.database,
  metaDatabase: setup.metaDatabase,
  policies,
  authenticator,
  contexts,
})
const handler = createGraphqlHandler({
  reads: rest.reads,
  writes: rest.writes,
  policies,
  authenticator,
  contexts,
  schemas: new SchemaCache(db),
  collections: setup.collections,
})
const server = createServer(toNodeListener((request, info) => handler.fetch(request, info)))
server.keepAliveTimeout = 60_000
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`)
const stop = (): void => {
  server.close()
  void client.close().finally(() => process.exit(0))
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.stdin.on("end", stop)
