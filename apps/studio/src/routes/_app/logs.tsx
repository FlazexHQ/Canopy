import { createFileRoute } from "@tanstack/react-router"
import { LogsPage } from "../../features/logs-and-audit/page.tsx"

export const Route = createFileRoute("/_app/logs")({ component: LogsPage })
