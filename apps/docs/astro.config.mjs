import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  integrations: [
    starlight({
      title: "Canopy",
      description:
        "An open source, self hostable backend for MongoDB: live queries, Document Level Security, auth, REST and GraphQL.",
      lastUpdated: false,
      pagination: true,
      sidebar: [
        {
          label: "Start here",
          items: [
            "start/introduction",
            "start/built-in-auth",
            "start/sidecar",
            "start/embedded",
            "start/platform",
          ],
        },
        {
          label: "Concepts",
          items: [
            "concepts/document-level-security",
            "concepts/realtime",
            "concepts/optimistic-client",
            "concepts/auth",
          ],
        },
        {
          label: "Guides",
          items: [
            "guides/rest",
            "guides/graphql",
            "guides/client",
            "guides/frameworks",
            "guides/server-rendering",
            "guides/react-native",
            "guides/multi-tab",
            "guides/rate-limits",
            "guides/webhooks",
            "guides/storage",
            "guides/devtools",
            "guides/tanstack-db",
            "guides/two-factor-and-passkeys",
            "guides/importing-users",
            "guides/studio",
          ],
        },
        {
          label: "Operations",
          items: [
            "operations/kubernetes",
            "operations/several-instances",
            "operations/tracing",
            "operations/backup-and-restore",
            "operations/key-rotation",
            "operations/change-stream-history",
            "operations/upgrades",
          ],
        },
        {
          label: "Recipes",
          items: ["recipes/pagination", "recipes/infinite-lists", "recipes/multi-tenant"],
        },
        {
          label: "Migrating",
          items: ["migrating/atlas-app-services", "migrating/parse", "migrating/firebase"],
        },
        {
          label: "Troubleshooting",
          collapsed: true,
          items: [{ autogenerate: { directory: "errors" } }],
        },
        {
          label: "Reference",
          items: [
            "reference/configuration",
            "reference/cli",
            "reference/protocol",
            "reference/errors",
            {
              label: "API",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/api" } }],
            },
          ],
        },
      ],
    }),
  ],
})
