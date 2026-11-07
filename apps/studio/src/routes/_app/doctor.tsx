import { createFileRoute } from "@tanstack/react-router"
import { DoctorPage } from "../../features/doctor/page.tsx"

export const Route = createFileRoute("/_app/doctor")({ component: DoctorPage })
