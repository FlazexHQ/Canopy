import { createClient } from "@canopy/client"
import { indexedDbPersister } from "@canopy/client/persist"
import { CanopyProvider } from "@canopy/react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { token, user } from "./session.ts"

const client = createClient({
  url: location.origin,
  publishableKey: document.querySelector<HTMLMetaElement>('meta[name="canopy-key"]')?.content ?? "",
  auth: { getToken: token },
  persist: indexedDbPersister({ name: "todo-react" }),
  cacheDocuments: true,
  fallback: () => import("@canopy/client/fallback"),
})

const root = document.getElementById("root")
if (root === null) throw new Error("The page has no #root element")
createRoot(root).render(
  <CanopyProvider client={client}>
    <App user={user} />
  </CanopyProvider>,
)
