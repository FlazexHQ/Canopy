import { defineProject } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default defineProject({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    name: "embedded",
    include: ["test/**/*.test.ts"],
  },
})
