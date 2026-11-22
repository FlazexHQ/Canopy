import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: { name: "chatapp", environment: "happy-dom", include: ["test/**/*.test.tsx"] },
  }),
)
