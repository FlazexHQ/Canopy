import type { ClaimsHook } from "@canopy/server"
import { builtin, defineConfig, email } from "canopy.js/config"

export default defineConfig({
  policies: { source: "database" },
  auth: builtin<ClaimsHook>({
    anonymous: true,
    trustedProxies: ["127.0.0.1", "::1"],
    emailPassword: { requireEmailVerification: true },
    email: { from: "Canopy <auth@example.com>", transport: email.log() },
    async claims({ db, signal }) {
      if (await db.collection("sdk_e2e_hooks").findOne({ fail: true }, { signal }))
        throw new Error("SDK auth test claims hook failure")
    },
  }),
})
