import { Hydrate } from "canopy.js/react"
import { createServerClient, dehydrate } from "canopy.js/server"
import type { ReactNode } from "react"
import { Articles } from "./articles.tsx"
import { CANOPY_KEY, CANOPY_URL, type Database, LATEST } from "./canopy.ts"

export const dynamic = "force-dynamic"

/** A Server Component: reads the latest articles under the policies, then hands them to the browser. */
export default async function Page(): Promise<ReactNode> {
  const server = createServerClient<Database>({ url: CANOPY_URL, publishableKey: CANOPY_KEY })
  const latest = await server.find("articles", LATEST.filter, LATEST.options)
  return (
    <main>
      <h1>Latest articles</h1>
      <Hydrate state={dehydrate([latest])}>
        <Articles />
      </Hydrate>
    </main>
  )
}
