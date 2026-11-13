import { defineConfig, env } from "@canopy/config"

/**
 * The config behind `bun run dev`. It targets the replica set of `bun run db:up` unless MONGODB_URI is set
 * (here or in a `.env.local` file next to this file). Without configured keys `canopy dev` generates a
 * publishable and a secret key for the session and prints them.
 */
export default defineConfig({
  mongodb: {
    uri: env("MONGODB_URI", { default: "mongodb://localhost:27017/?replicaSet=rs0" }),
    database: "canopy_dev_app",
  },
  keys: {
    publishable: env.list.optional("CANOPY_PUBLISHABLE_KEYS"),
    secret: env.list.optional("CANOPY_SECRET_KEYS"),
  },
  policies: { dir: "./policies" },
})
