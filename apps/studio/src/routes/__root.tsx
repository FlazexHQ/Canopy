import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"
import type { RouterContext } from "../app/context.tsx"
import { Toaster } from "../components/toast.tsx"
import { TooltipProvider } from "../components/ui/tooltip.tsx"
import { NotFound } from "../features/shell/not-found.tsx"

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <Toaster>
        <Outlet />
      </Toaster>
    </TooltipProvider>
  ),
  notFoundComponent: NotFound,
})
