import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: "studio-app",
      include: ["test/**/*.test.{ts,tsx}"],
      environment: "happy-dom",
      setupFiles: ["./test/setup.ts"],
    },
  }),
)
