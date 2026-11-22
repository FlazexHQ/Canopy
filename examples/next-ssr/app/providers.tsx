"use client"

import { createClient } from "canopy.js"
import { CanopyProvider } from "canopy.js/react"
import { type ReactNode, useState } from "react"
import { CANOPY_KEY, CANOPY_URL, type Database } from "./canopy.ts"

/** Creates one client per browser tab and provides it to the client components below. */
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  const [client] = useState(() =>
    createClient<Database>({ url: CANOPY_URL, publishableKey: CANOPY_KEY }),
  )
  return <CanopyProvider client={client}>{children}</CanopyProvider>
}
