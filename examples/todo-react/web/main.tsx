import { createClient } from "canopy.js"
import { indexedDbPersister } from "canopy.js/persist"
import { CanopyProvider } from "canopy.js/react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { schema } from "./canopy.schema.ts"
import { token, user } from "./session.ts"

const client = createClient({
  url: location.origin,
  schema,
  publishableKey: document.querySelector<HTMLMetaElement>('meta[name="canopy-key"]')?.content ?? "",
  auth: { getToken: token },
  persist: indexedDbPersister({ name: "todo-react" }),
  cacheDocuments: true,
  fallback: () => import("canopy.js/fallback"),
})

const root = document.getElementById("root")
if (root === null) throw new Error("The page has no #root element")
createRoot(root).render(
  <CanopyProvider client={client}>
    <App user={user} />
  </CanopyProvider>,
)
