import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"

/**
 * Settings shared by every package's Vitest project. Workspace packages export their TypeScript sources under
 * the `@canopy/source` condition, so tests run against source without a build step. `graphql` has no `exports`
 * map, so Vite would load its ESM build while externalized libraries such as GraphQL Yoga load the CommonJS
 * one; the alias makes both use the CommonJS build, as Node does. Under Deno, a setup file
 * fills in a worker API that Vitest's thread pool needs (run Deno with `--pool=threads`). With
 * `CANOPY_REQUIRE_MONGODB=1`, every run fails unless `CANOPY_TEST_MONGODB_URI` is set, so CI cannot pass with
 * the MongoDB suites skipped.
 */
export const sharedConfig = defineProject({
  resolve: {
    conditions: ["@canopy/source", "module", "browser", "development|production"],
    alias: [{ find: /^graphql$/, replacement: "graphql/index.js" }],
  },
  test: {
    setupFiles: [
      fileURLToPath(new URL("./vitest.require-mongodb.ts", import.meta.url)),
      ...("Deno" in globalThis
        ? [fileURLToPath(new URL("./vitest.deno-setup.ts", import.meta.url))]
        : []),
    ],
  },
  ssr: {
    resolve: {
      conditions: ["@canopy/source", "node", "module", "development|production"],
    },
  },
})
