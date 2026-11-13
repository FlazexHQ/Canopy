import { existsSync, readdirSync } from "node:fs"
import { defineConfig } from "vitest/config"

const projects = ["packages", "apps", "examples"]
  .filter((dir) => existsSync(dir) && readdirSync(dir).length > 0)
  .map((dir) => `${dir}/*`)

/**
 * Coverage floors of the packages where a mismatch is a DLS bug, a little under what the suite reaches
 * against a replica set, so a drop fails CI. The target for all four is 90 % lines and 80 % branches.
 */
const floors = {
  "packages/matcher/src/**": { lines: 84, branches: 72 },
  "packages/query/src/**": { lines: 88, branches: 79 },
  "packages/policy/src/**": { lines: 93, branches: 83 },
  "packages/realtime/src/**": { lines: 81, branches: 69 },
}

export default defineConfig({
  test: {
    ...(projects.length > 0 ? { projects } : { include: [], passWithNoTests: true }),
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["apps/docs/**"],
      reporter: ["text-summary", "json-summary"],
      thresholds: floors,
    },
  },
})
