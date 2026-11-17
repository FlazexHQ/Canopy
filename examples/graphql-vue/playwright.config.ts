import { defineConfig, devices } from "@playwright/test"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]
const database = `board_e2e_${process.env["BOARD_E2E_RUN"] ?? "local"}`
const port = Number(process.env["BOARD_E2E_PORT"] ?? "4337")

/**
 * Browser tests of the example. They need a MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and start the
 * notes server on it with a fresh database.
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
  metadata: { database },
  ...(uri === undefined
    ? {}
    : {
        webServer: {
          command: "node --conditions=@canopy/source src/server.ts",
          url: `http://127.0.0.1:${port}/`,
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: "pipe",
          env: {
            PORT: String(port),
            PUBLIC_URL: `http://127.0.0.1:${port}`,
            MONGODB_URI: uri,
            BOARD_DB: database,
            CANOPY_PUBLISHABLE_KEY: "pk_board_e2e",
            CANOPY_MASTER_KEY: "e2e-master-key-".repeat(4),
          },
        },
      }),
})
