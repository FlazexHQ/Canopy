import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"
import type { RouterContext } from "../app/context.tsx"
import { Toaster } from "../components/toast.tsx"
import { NotFound } from "../features/shell/not-found.tsx"

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <Toaster>
      <Outlet />
    </Toaster>
  ),
  notFoundComponent: NotFound,
})
