import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"

/**
 * Settings shared by every package's Vitest project. Workspace packages export their TypeScript sources under
 * the `@canopy/source` condition, so tests run against source without a build step. Under Deno, a setup file
 * fills in a worker API that Vitest's thread pool needs (run Deno with `--pool=threads`).
 */
export const sharedConfig = defineProject({
  resolve: {
    conditions: ["@canopy/source", "module", "browser", "development|production"],
  },
  test: {
    setupFiles:
      "Deno" in globalThis
        ? [fileURLToPath(new URL("./vitest.deno-setup.ts", import.meta.url))]
        : [],
  },
  ssr: {
    resolve: {
      conditions: ["@canopy/source", "node", "module", "development|production"],
    },
  },
})
