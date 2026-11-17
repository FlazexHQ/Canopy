import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: "graphql-vue",
      include: ["test/**/*.test.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
)
