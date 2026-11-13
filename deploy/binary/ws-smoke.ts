/**
 * Smoke test of the realtime WebSocket path of a running server: connects with a secret key, subscribes
 * to a collection, waits for `ready`, inserts a document through a mutation and waits for its `ack`.
 *
 *     bun deploy/binary/ws-smoke.ts ws://127.0.0.1:18090/realtime/v1 <secret key> [collection]
 *
 * Needs a runtime with a global WebSocket (Bun, Node 22 and newer, Deno).
 */
const [url, key, collection = "notes"] = process.argv.slice(2)
if (url === undefined || key === undefined) {
  process.stderr.write("usage: ws-smoke.ts <ws url> <secret key> [collection]\n")
  process.exit(2)
}

const SUBPROTOCOL = "canopy.v1+json"
const TIMEOUT_MS = 15_000

interface Frame {
  readonly t?: string
  readonly s?: string
  readonly m?: string
  readonly ok?: boolean
}

const socket = new WebSocket(url, SUBPROTOCOL)
const seen: Frame[] = []
const waiting: { test: (frame: Frame) => boolean; resolve: () => void }[] = []

socket.addEventListener("message", (event) => {
  const frame = JSON.parse(String(event.data)) as Frame & { m?: Frame[] }
  for (const part of frame.t === "batch" && Array.isArray(frame.m) ? frame.m : [frame]) {
    seen.push(part)
    for (const waiter of [...waiting]) {
      if (waiter.test(part)) {
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }
})

function fail(message: string): never {
  process.stderr.write(
    `ws-smoke: ${message}; frames: ${JSON.stringify(seen.map((frame) => frame.t))}\n`,
  )
  process.exit(1)
}

function next(test: (frame: Frame) => boolean, what: string): Promise<void> {
  if (seen.some(test)) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(`timed out waiting for ${what}`), TIMEOUT_MS)
    waiting.push({
      test,
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
    })
  })
}

socket.addEventListener("error", () => fail("the WebSocket failed"))
await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()))
if (socket.protocol !== SUBPROTOCOL) fail(`the server chose the subprotocol "${socket.protocol}"`)

socket.send(JSON.stringify({ t: "hello", v: 1, key, caps: [] }))
await next((frame) => frame.t === "welcome", "welcome")
socket.send(JSON.stringify({ t: "sub", id: "smoke", c: collection, q: {} }))
await next((frame) => frame.t === "ready" && frame.s === "smoke", "ready")

const id = crypto.randomUUID()
socket.send(
  JSON.stringify({
    t: "mut",
    id,
    c: collection,
    op: "insert",
    args: { doc: { ownerId: "ws_smoke" } },
  }),
)
await next((frame) => frame.t === "ack" && frame.m === id, "the mutation ack")
if (seen.find((frame) => frame.t === "ack" && frame.m === id)?.ok !== true)
  fail("the mutation was refused")

socket.send(JSON.stringify({ t: "bye" }))
socket.close()
process.stdout.write("ws-smoke: subscribe and mutate round trip ok\n")
process.exit(0)
