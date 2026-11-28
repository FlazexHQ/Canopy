import { defineProject } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default defineProject({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    name: "control",
    include: ["test/**/*.test.ts"],
  },
})
