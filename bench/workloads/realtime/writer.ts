import { MongoClient } from "mongodb"

/**
 * Load generator for the fan out benchmark, run as its own process so it does not share the engine's event
 * loop. Updates documents at a fixed rate and stamps each with the wall clock time of the write in `ts`.
 *
 * Arguments: `<uri> <database> <rate> <seconds> <mode> <a> <b>`. In `owners` mode it updates a random
 * document of a random owner below `a`, with `b` documents per owner spread with stride `owners`
 * (passed as the eighth argument). In `hot` mode it updates a random document among the first `a`.
 */
const [uri, database, rateText, secondsText, mode, aText, bText, ownersText] = process.argv.slice(2)
if (uri === undefined || database === undefined || mode === undefined) {
  process.stderr.write(
    "usage: writer.ts <uri> <database> <rate> <seconds> <mode> <a> <b> <owners>\n",
  )
  process.exit(2)
}
const rate = Number(rateText)
const seconds = Number(secondsText)
const a = Number(aText)
const b = Number(bText)
const owners = Number(ownersText ?? "1")

const client = new MongoClient(uri, { maxPoolSize: 100 })
await client.connect()
const coll = client.db(database).collection<{ _id: number }>("items")
const now = (): number => performance.timeOrigin + performance.now()
const total = Math.round(rate * seconds)
const interval = 1000 / rate
const start = performance.now()
let issued = 0
let errors = 0
const acks: number[] = []
const pending = new Set<Promise<void>>()
await new Promise<void>((resolve) => {
  const tick = (): void => {
    const current = performance.now()
    while (issued < total && start + issued * interval <= current) {
      issued += 1
      const id =
        mode === "hot"
          ? Math.floor(Math.random() * a)
          : Math.floor(Math.random() * b) * owners + Math.floor(Math.random() * a)
      const stamp = now()
      const write = coll
        .updateOne({ _id: id }, { $set: { ts: stamp }, $inc: { n: 1 } })
        .then(
          () => {
            acks.push(now() - stamp)
          },
          () => {
            errors += 1
          },
        )
        .finally(() => pending.delete(write))
      pending.add(write)
    }
    if (issued >= total) resolve()
    else setTimeout(tick, 1)
  }
  tick()
})
await Promise.all(pending)
await client.close()
acks.sort((x, y) => x - y)
const at = (p: number): number =>
  acks[Math.min(acks.length - 1, Math.max(0, Math.ceil((p / 100) * acks.length) - 1))] ?? Number.NaN
const elapsed = (performance.now() - start) / 1000
process.stdout.write(
  `${JSON.stringify({ issued, errors, elapsed, ack: { p50: at(50), p99: at(99) } })}\n`,
)
