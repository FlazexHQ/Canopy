import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { statusOf } from "../api/client.ts"
import { meQuery } from "../app/context.tsx"
import { ViewAsProvider } from "../app/view-as.tsx"
import { Shell } from "../components/shell.tsx"
import { PasswordGate } from "../features/session/change-password.tsx"

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery(context.api))
    } catch (error: unknown) {
      if (statusOf(error) !== 401) throw error
      const setup = await context.api.setupStatus().catch(() => ({ required: false }))
      if (setup.required) throw redirect({ to: "/setup" })
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: () => (
    <PasswordGate>
      <ViewAsProvider>
        <Shell>
          <Outlet />
        </Shell>
      </ViewAsProvider>
    </PasswordGate>
  ),
})
