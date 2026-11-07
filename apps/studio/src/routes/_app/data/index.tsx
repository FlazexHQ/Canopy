import { createFileRoute } from "@tanstack/react-router"
import { CollectionsPage } from "../../../features/data/collections.tsx"

export const Route = createFileRoute("/_app/data/")({ component: CollectionsPage })
