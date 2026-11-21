import { existsSync, readdirSync } from "node:fs"
import { defineConfig } from "vitest/config"

/** Every folder under `packages`, `apps` and `examples` with a Vitest config of its own. */
const projects = ["packages", "apps", "examples"]
  .filter((dir) => existsSync(dir))
  .flatMap((dir) => readdirSync(dir).map((name) => `${dir}/${name}`))
  .filter((dir) => existsSync(`${dir}/vitest.config.ts`))

/**
 * Coverage floors, a little under what the whole suite reaches against a replica set on Node, so a drop
 * fails CI. They apply to a full run (`vitest run --coverage`); a run limited with `--project` resolves
 * globs against that project's folder, so it reports numbers but does not check the floors. The target
 * for matcher, query, policy and realtime is 90 % lines and 80 % branches.
 */
const floors = {
  "packages/matcher/src/**": { lines: 84, branches: 72 },
  "packages/query/src/**": { lines: 88, branches: 79 },
  "packages/policy/src/**": { lines: 93, branches: 83 },
  "packages/realtime/src/**": { lines: 81, branches: 69 },
  "packages/rest/src/**": { lines: 94, branches: 84 },
  "packages/server/src/**": { lines: 82, branches: 71 },
  "packages/client/src/**": { lines: 91, branches: 75 },
  "packages/auth/src/**": { lines: 97, branches: 93 },
  "packages/auth-builtin/src/**": { lines: 88, branches: 78 },
  "packages/graphql/src/**": { lines: 94, branches: 79 },
  "packages/protocol/src/**": { lines: 96, branches: 85 },
  "packages/vue/src/**": { lines: 98, branches: 70 },
  "packages/svelte/src/**": { lines: 98, branches: 98 },
  "packages/solid/src/**": { lines: 98, branches: 98 },
}

export default defineConfig({
  test: {
    ...(projects.length > 0 ? { projects } : { include: [], passWithNoTests: true }),
    coverage: {
      provider: "v8",
      include: ["src/**", "packages/*/src/**", "apps/*/src/**"],
      exclude: ["apps/docs/**", "**/*.rs"],
      reporter: ["text-summary", "json-summary"],
      thresholds: floors,
    },
  },
})
