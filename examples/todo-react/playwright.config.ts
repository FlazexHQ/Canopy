import { generateKeyPairSync } from "node:crypto"
import { defineConfig, devices } from "@playwright/test"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]
const database = `todo_e2e_${process.env["TODO_E2E_RUN"] ?? "local"}`
const port = Number(process.env["TODO_E2E_PORT"] ?? "4317")
const issuerKey = JSON.stringify(
  generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
)
const server = (listen: number, extra: Record<string, string>) => ({
  command: "node --conditions=@canopy/source src/server.ts",
  url: `http://127.0.0.1:${listen}/`,
  reuseExistingServer: false,
  timeout: 60_000,
  stdout: "pipe" as const,
  env: {
    PORT: String(listen),
    MONGODB_URI: uri ?? "",
    TODO_DB: database,
    CANOPY_META_DB: `${database}_meta`,
    CANOPY_PUBLISHABLE_KEY: "pk_todo_e2e",
    TODO_DEV_ISSUER_KEY: issuerKey,
    ...extra,
  },
})

/**
 * Browser tests of the example. They need a MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and start
 * two servers on it: a regular one, and one that refuses WebSockets so clients fall back to SSE.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  metadata: { database, fallbackPort: port + 1 },
  ...(uri === undefined
    ? {}
    : {
        webServer: [server(port, {}), server(port + 1, { TODO_DISABLE_WEBSOCKETS: "1" })],
      }),
})
