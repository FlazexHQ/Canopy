import { defineProject } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

/**
 * The shared resolve conditions without `module`: the OpenTelemetry packages map `module` to an ESM build
 * with extensionless imports that Node cannot load, and Node itself never applies that condition.
 */
const withoutModule = (conditions: readonly string[] | undefined): string[] =>
  (conditions ?? []).filter((condition) => condition !== "module")

export default defineProject({
  ...sharedConfig,
  resolve: {
    ...sharedConfig.resolve,
    conditions: withoutModule(sharedConfig.resolve?.conditions),
  },
  ssr: {
    ...sharedConfig.ssr,
    resolve: {
      ...sharedConfig.ssr?.resolve,
      conditions: withoutModule(sharedConfig.ssr?.resolve?.conditions),
    },
  },
  test: {
    ...sharedConfig.test,
    name: "server",
    include: ["test/**/*.test.ts"],
  },
})
