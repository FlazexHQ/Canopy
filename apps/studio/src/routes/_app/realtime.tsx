import { createFileRoute } from "@tanstack/react-router"
import { RealtimePage } from "../../features/realtime/page.tsx"

export const Route = createFileRoute("/_app/realtime")({ component: RealtimePage })
