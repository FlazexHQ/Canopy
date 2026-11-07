import { createFileRoute } from "@tanstack/react-router"
import { LoginPage } from "../features/session/login.tsx"

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {},
  component: LoginPage,
})
