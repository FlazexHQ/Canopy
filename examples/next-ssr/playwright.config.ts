import { defineConfig, devices } from "@playwright/test"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]
const database = `next_e2e_${process.env["NEXT_E2E_RUN"] ?? "local"}`
const port = Number(process.env["NEXT_E2E_PORT"] ?? "4347")
const canopyPort = port + 1
const site = `http://127.0.0.1:${port}`
const env = {
  MONGODB_URI: uri ?? "",
  ARTICLES_DB: database,
  CANOPY_PORT: String(canopyPort),
  SITE_URL: site,
  NEXT_PUBLIC_CANOPY_URL: `http://127.0.0.1:${canopyPort}`,
  NEXT_PUBLIC_CANOPY_KEY: "pk_next_e2e",
  NEXT_TELEMETRY_DISABLED: "1",
}

/**
 * Browser tests of the example. They need a MongoDB replica set in `CANOPY_TEST_MONGODB_URI`, start
 * Canopy, and build and start the Next.js app against it.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: { baseURL: site, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  metadata: { database },
  ...(uri === undefined
    ? {}
    : {
        webServer: [
          {
            command: "node --conditions=@canopy/source canopy/server.ts",
            url: `http://127.0.0.1:${canopyPort}/healthz`,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: "pipe",
            env,
          },
          {
            command: `node node_modules/next/dist/bin/next build && node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
            url: site,
            reuseExistingServer: false,
            timeout: 240_000,
            stdout: "pipe",
            env,
          },
        ],
      }),
})
