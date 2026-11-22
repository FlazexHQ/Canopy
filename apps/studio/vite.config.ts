import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { cspStyles } from "./csp-styles.ts"

const SOURCE_CONDITIONS = [
  "@canopy/source",
  "canopy-js-source",
  "module",
  "browser",
  "development|production",
]

/** Serves the in memory admin API of `mock/` under `/admin/v1` while developing without a server. */
function mockAdmin(): Plugin {
  return {
    name: "canopy-studio-mock-admin",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url ?? "/"
        if (!path.startsWith("/admin/v1") && !path.startsWith("/rest/v1/openapi.json"))
          return next()
        server
          .ssrLoadModule("/dev/mock-middleware.ts")
          .then((module: Record<string, unknown>) => {
            const handle = module["handle"] as (
              req: typeof request,
              res: typeof response,
            ) => Promise<void>
            return handle(request, response)
          })
          .catch(next)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const target = process.env["CANOPY_URL"] ?? "http://127.0.0.1:8080"
  return {
    base: "/studio/",
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        addExtensions: true,
        quoteStyle: "double",
        semicolons: false,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }),
      cspStyles(),
      react(),
      tailwindcss(),
      ...(mode === "mock" ? [mockAdmin()] : []),
    ],
    resolve: { conditions: SOURCE_CONDITIONS },
    ssr: {
      resolve: { conditions: ["@canopy/source", "node", "module", "development|production"] },
    },
    server: {
      port: 5174,
      proxy:
        mode === "mock"
          ? {}
          : Object.fromEntries(
              ["/admin", "/rest", "/realtime", "/auth"].map((prefix) => [
                prefix,
                { target, changeOrigin: false, ws: prefix === "/realtime" },
              ]),
            ),
    },
    build: {
      outDir: fileURLToPath(new URL("../../packages/studio/app", import.meta.url)),
      emptyOutDir: true,
      target: "es2023",
      sourcemap: false,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 4096,
    },
  }
})
