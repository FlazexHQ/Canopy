import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: "react",
      include: ["test/**/*.test.tsx"],
      environment: "happy-dom",
    },
  }),
)
