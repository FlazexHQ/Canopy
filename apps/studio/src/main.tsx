import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRouter, RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AdminApi } from "./api/client.ts"
import { ApiProvider } from "./app/context.tsx"
import { applyTheme, watchSystemTheme } from "./app/theme.ts"
import { routeTree } from "./routeTree.gen.ts"
import "./styles.css"

applyTheme()
watchSystemTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => {
        const status = (error as { details?: { status?: number } }).details?.status
        return status !== undefined && status < 500 ? false : count < 2
      },
      refetchOnWindowFocus: false,
    },
  },
})

let router: ReturnType<typeof createStudioRouter> | undefined
const api = new AdminApi({
  onUnauthorized: () => {
    queryClient.removeQueries({ queryKey: ["me"] })
    const path = window.location.pathname
    if (router !== undefined && !path.endsWith("/login") && !path.endsWith("/setup")) {
      void router.navigate({ to: "/login" })
    }
  },
})

function createStudioRouter() {
  return createRouter({
    routeTree,
    basepath: import.meta.env.BASE_URL,
    context: { api, queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  })
}

router = createStudioRouter()

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createStudioRouter>
  }
}

const root = document.getElementById("root")
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ApiProvider api={api}>
          <RouterProvider router={router} />
        </ApiProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}
