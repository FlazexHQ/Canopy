import { createFileRoute } from "@tanstack/react-router"
import { PolicyEditorPage } from "../../../features/policies/editor-page.tsx"

export const Route = createFileRoute("/_app/policies/$collection")({
  component: function Policies() {
    const { collection } = Route.useParams()
    return <PolicyEditorPage collection={collection} />
  },
})
