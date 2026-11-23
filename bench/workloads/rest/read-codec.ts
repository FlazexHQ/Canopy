import { loadNativeEngine } from "@canopy/native"
import { encode } from "@canopy/protocol"
import { MongoClient } from "mongodb"
import { EXACT_BSON } from "../../../packages/rest/src/driver.ts"
import { type Order, seedTo } from "./scenarios.ts"

/**
 * Upper bound for the native REST read path (stage 4 of the native core): the client CPU of reading a page and
 * encoding it as relaxed EJSON, once as the read path does it today (the driver decodes every document into
 * JavaScript values, then `encode` and `JSON.stringify`) and once with raw BSON from the driver encoded by the
 * Rust codec. HTTP, policies and the envelope are left out, so the ratio here bounds the ratio a whole request
 * can reach. Also counts pages whose bytes differ between the two, which must be zero.
 *
 *   CANOPY_BENCH_MONGODB_URI=... node --conditions=@canopy/source workloads/rest/read-codec.ts
 */
const uri = process.env["CANOPY_BENCH_MONGODB_URI"] ?? "mongodb://localhost:27017/?replicaSet=rs0"
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "6")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "8")
const DOCUMENTS = 20_000

type Encoder = (page: number, size: number) => Promise<string>

async function measure(
  encoder: Encoder,
  size: number,
): Promise<{ ops: number; cpuMicros: number }> {
  const deadline = performance.now() + SECONDS * 1000
  const start = process.cpuUsage()
  let ops = 0
  const worker = async (offset: number): Promise<void> => {
    for (let i = offset; performance.now() < deadline; i += CONCURRENCY) {
      await encoder(i, size)
      ops += 1
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, offset) => worker(offset)))
  const used = process.cpuUsage(start)
  return { ops, cpuMicros: used.user + used.system }
}

async function main(): Promise<void> {
  const client = new MongoClient(uri)
  await client.connect()
  const orders = client.db("canopy_bench_codec").collection<Order>("orders")
  if ((await orders.estimatedDocumentCount()) < DOCUMENTS) {
    await orders.deleteMany({})
    await seedTo(orders, 0, DOCUMENTS)
  }
  await orders.createIndex({ tenantId: 1, _id: 1 })
  const core = loadNativeEngine("native")
  const query = (page: number) => ({ tenantId: `t${page % 100}` })
  const ts: Encoder = async (page, size) => {
    const docs = await orders
      .find(query(page), { sort: { _id: 1 }, limit: size, ...EXACT_BSON })
      .toArray()
    return JSON.stringify(encode(docs))
  }
  const rust: Encoder = async (page, size) => {
    const docs = (await orders
      .find(query(page), { sort: { _id: 1 }, limit: size, raw: true })
      .toArray()) as unknown as Uint8Array[]
    return `[${docs.map((bytes) => core.bsonToEjson(bytes, false)).join(",")}]`
  }
  for (const size of [20, 100]) {
    let differing = 0
    for (let page = 0; page < 200; page += 1) {
      if ((await ts(page, size)) !== (await rust(page, size))) differing += 1
    }
    const rounds = []
    for (let round = 0; round < 3; round += 1) {
      const a = await measure(ts, size)
      const b = await measure(rust, size)
      rounds.push(a.cpuMicros / a.ops / (b.cpuMicros / b.ops))
      process.stdout.write(
        `page ${String(size)}: ts ${(a.cpuMicros / a.ops).toFixed(0)} µs/op, rust ${(b.cpuMicros / b.ops).toFixed(0)} µs/op\n`,
      )
    }
    rounds.sort((x, y) => x - y)
    process.stdout.write(
      `page ${String(size)}: rust ÷ ts throughput per CPU, median ${String(rounds[1]?.toFixed(2))}; ${String(differing)} of 200 pages differ\n`,
    )
  }
  await client.close()
}

await main()
