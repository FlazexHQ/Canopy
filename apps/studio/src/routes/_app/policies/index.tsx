import { createFileRoute } from "@tanstack/react-router"
import { PoliciesIndexPage } from "../../../features/policies/index-page.tsx"

export const Route = createFileRoute("/_app/policies/")({ component: PoliciesIndexPage })
