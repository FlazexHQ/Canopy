import { createFileRoute } from "@tanstack/react-router"
import { LogsPage } from "../../features/logs/page.tsx"

export const Route = createFileRoute("/_app/logs")({ component: LogsPage })
