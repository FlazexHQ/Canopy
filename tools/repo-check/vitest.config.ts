import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "repo-check",
    include: ["src/**/*.test.ts"],
  },
})
