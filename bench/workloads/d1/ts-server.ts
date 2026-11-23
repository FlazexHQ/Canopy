import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"
import { Authenticator } from "@canopy/auth"
import { toNodeListener } from "@canopy/node-http"
import { contextsFromStored, createPolicySet, fromStored, PolicyEngine } from "@canopy/policy"
import { createRestHandler } from "@canopy/rest"
import { MongoClient } from "mongodb"

/**
 * The TypeScript REST handler of the D1 benchmark in a process of its own, so its CPU can be measured apart
 * from the load generator. Reads one JSON line on stdin (the MongoDB target, the stored policies and the JWT
 * settings, the same ones the gateway gets) and prints `{"port":<n>}` once it listens.
 */
interface Setup {
  readonly uri: string
  readonly database: string
  readonly metaDatabase: string
  readonly issuer: string
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] }
  readonly publishable: readonly string[]
  readonly secret: readonly string[]
  readonly stored: readonly unknown[]
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
const client = new MongoClient(setup.uri, { maxPoolSize: 200 })
await client.connect()
const set = createPolicySet(
  setup.stored.map((stored) => fromStored(stored)),
  contextsFromStored(setup.contexts),
)
const handler = createRestHandler({
  client,
  database: setup.database,
  metaDatabase: setup.metaDatabase,
  policies: new PolicyEngine(set),
  authenticator: new Authenticator(
    { jwks: { keys: [...setup.jwks.keys] }, issuer: setup.issuer },
    { publishable: [...setup.publishable], secret: [...setup.secret] },
  ),
  idTypes: { orders: "number" },
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
