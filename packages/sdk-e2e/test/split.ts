import { type CollectionPolicies, toStored } from "@canopy/policy"
import { importJWK } from "jose"
import type { MongoClient } from "mongodb"

export const splitUrl = process.env["CANOPY_SPLIT_E2E_URL"]
export const splitDatabase = process.env["CANOPY_DB"] ?? "app"
const splitMetaDatabase = process.env["CANOPY_META_DB"] ?? "canopy"

export const splitIssuer = "https://todo-react.example/dev-issuer"
export const splitAudience = "https://todo-react.example/api"

export async function splitSigningKey() {
  const key = process.env["TODO_DEV_ISSUER_KEY"]
  if (key === undefined) throw new Error("Missing TODO_DEV_ISSUER_KEY for the split gateway")
  return importJWK(JSON.parse(key), "EdDSA")
}

export async function seedSplitPolicy(
  mongo: MongoClient,
  definition: CollectionPolicies,
  headers: Record<string, string>,
): Promise<void> {
  const policies = mongo
    .db(splitMetaDatabase)
    .collection<{ _id: string; version: number }>("policies")
  const { collection } = definition
  const current = await policies.findOne({ _id: collection })
  const version = (current?.version ?? 0) + 1
  await mongo.db(splitDatabase).collection(collection).deleteMany({})
  if (current !== null) {
    await policies.deleteOne({ _id: collection })
    await waitForPolicy(collection, headers, false)
  }
  await policies.replaceOne({ _id: collection }, toStored(definition, { version }), {
    upsert: true,
  })
  await waitForPolicy(collection, headers, true)
}

async function waitForPolicy(
  collection: string,
  headers: Record<string, string>,
  exposed: boolean,
): Promise<void> {
  if (splitUrl === undefined) throw new Error("Missing CANOPY_SPLIT_E2E_URL")
  const deadline = Date.now() + 10_000
  for (;;) {
    const response = await fetch(new URL(`/rest/v1/${collection}`, splitUrl), {
      headers,
      signal: AbortSignal.timeout(2_000),
    })
    await response.body?.cancel()
    if (exposed ? response.ok : response.status === 403 || response.status === 404) return
    if (Date.now() >= deadline)
      throw new Error(`Unexpected gateway response for ${collection}: HTTP ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
