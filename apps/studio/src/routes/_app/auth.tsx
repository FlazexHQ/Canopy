import { createFileRoute } from "@tanstack/react-router"
import { AuthPage } from "../../features/auth/page.tsx"

export const Route = createFileRoute("/_app/auth")({ component: AuthPage })
