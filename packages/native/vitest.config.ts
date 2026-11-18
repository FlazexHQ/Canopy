import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: "native",
      include: ["test/**/*.test.ts"],
      testTimeout: 300_000,
    },
  }),
)
