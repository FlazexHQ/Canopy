import { createFileRoute } from "@tanstack/react-router"
import { DocumentsPage } from "../../../features/data/documents.tsx"

export const Route = createFileRoute("/_app/data/$collection")({
  component: function Documents() {
    const { collection } = Route.useParams()
    return <DocumentsPage collection={collection} />
  },
})
