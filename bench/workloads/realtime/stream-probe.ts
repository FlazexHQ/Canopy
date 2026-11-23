import { MongoClient } from "mongodb"

/**
 * Baseline for the fan out benchmark: a plain MongoDB change stream on the benchmark collection, in its
 * own process, that measures how long each stamped write takes to arrive without Canopy. Prints `ready`
 * once the stream is open, then a JSON line with the latency distribution after `<seconds>`.
 *
 * Arguments: `<uri> <database> <seconds>`.
 */
const [uri, database, secondsText] = process.argv.slice(2)
if (uri === undefined || database === undefined) {
  process.stderr.write("usage: stream-probe.ts <uri> <database> <seconds>\n")
  process.exit(2)
}
const seconds = Number(secondsText ?? "10")
const now = (): number => performance.timeOrigin + performance.now()

const client = new MongoClient(uri)
await client.connect()
const stream = client
  .db(database)
  .collection("items")
  .watch([{ $match: { operationType: "update" } }], { maxAwaitTimeMS: 50 })
const latencies: number[] = []
await stream.tryNext()
process.stdout.write("ready\n")
const deadline = performance.now() + seconds * 1000
while (performance.now() < deadline) {
  const change = await stream.tryNext()
  const received = now()
  if (change === null || change.operationType !== "update") continue
  const ts: unknown = change.updateDescription.updatedFields?.["ts"]
  if (typeof ts === "number") latencies.push(received - ts)
}
await stream.close()
await client.close()

latencies.sort((a, b) => a - b)
const at = (p: number): number =>
  latencies[
    Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))
  ] ?? Number.NaN
process.stdout.write(
  `${JSON.stringify({ count: latencies.length, p50: at(50), p90: at(90), p99: at(99), max: latencies.at(-1) ?? Number.NaN })}\n`,
)
