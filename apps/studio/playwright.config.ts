import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env["STUDIO_E2E_PORT"] ?? "4410")

/**
 * Browser tests of Studio against a real `canopy-server` on the replica set in `CANOPY_TEST_MONGODB_URI`.
 * Build Studio first (`bun --filter @canopy/studio-app build`); the global setup starts the server, which
 * serves the build at `/studio`.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
})
