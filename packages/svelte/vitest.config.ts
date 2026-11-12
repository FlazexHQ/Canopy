import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineProject, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.shared.ts"

export default mergeConfig(
  sharedConfig,
  defineProject({
    plugins: [svelte({ configFile: false })],
    test: {
      name: "svelte",
      include: ["test/**/*.test.ts"],
      environment: "happy-dom",
    },
  }),
)
