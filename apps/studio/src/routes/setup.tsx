import { createFileRoute } from "@tanstack/react-router"
import { SetupWizard } from "../features/setup/wizard.tsx"

export const Route = createFileRoute("/setup")({
  component: SetupWizard,
})
