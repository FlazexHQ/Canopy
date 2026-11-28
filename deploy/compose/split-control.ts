import { builtin, defineConfig } from "canopy.js/config"

export default defineConfig({
  policies: { source: "database" },
  ...(process.env["CANOPY_SPLIT_BUILTIN_AUTH"] === "on"
    ? {
        auth: builtin({
          emailPassword: { requireEmailVerification: process.env["CANOPY_ENV"] === "production" },
        }),
      }
    : {}),
})
