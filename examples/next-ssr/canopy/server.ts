import { createServer } from "node:http"
import { allow, collection, createPolicySet } from "@canopy/policy"
import { createCanopy, defineConfig } from "@canopy/server"

/**
 * Articles are public: anyone with the publishable key reads the published ones, live. Nobody writes them
 * through the API; an editor (here, the tests) writes to MongoDB directly and Canopy streams the change.
 */
const articles = collection("articles", {
  exposed: true,
  realtime: true,
  policies: [allow.read("anon", "authenticated").where({ published: true }).named("published")],
})

const env = process.env
const port = Number(env["CANOPY_PORT"] ?? "8090")
const database = env["ARTICLES_DB"] ?? "next_ssr"
const canopy = await createCanopy(
  defineConfig({
    mongodb: {
      uri: env["MONGODB_URI"] ?? "mongodb://localhost:27017/?replicaSet=rs0",
      database,
      metaDatabase: `${database}_meta`,
    },
    keys: { publishable: [env["NEXT_PUBLIC_CANOPY_KEY"] ?? "pk_next_local"] },
    cors: { origins: [env["SITE_URL"] ?? "http://localhost:3000"] },
    realtime: { checkpoints: "off" },
  }),
  { env: {}, policies: createPolicySet([articles]), admin: false, studio: false },
)
const server = createServer(canopy.node())
await canopy.attach(server)
server.listen(port, () => {
  process.stdout.write(`canopy for next-ssr on http://localhost:${port}\n`)
})

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  canopy
    .close({ drainMs: 0 })
    .then(() => {
      server.closeAllConnections()
      server.close(() => process.exit(0))
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
if (process.platform === "win32") process.on("SIGBREAK", stop)
