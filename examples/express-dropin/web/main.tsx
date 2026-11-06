import { createRoot } from "react-dom/client"
import { Dashboard } from "./dashboard.tsx"
import { SignIn } from "./session.tsx"
import type { PublicConfig } from "./types.ts"

const root = document.getElementById("root")
if (root === null) throw new Error("The page has no #root element")

const response = await fetch("/config.json")
const config = (await response.json()) as PublicConfig

createRoot(root).render(
  <SignIn auth={config.auth}>
    {(session) => <Dashboard config={config} session={session} />}
  </SignIn>,
)
