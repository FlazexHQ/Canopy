import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: "vue",
      include: ["test/**/*.test.ts"],
      environment: "happy-dom",
    },
  }),
)
