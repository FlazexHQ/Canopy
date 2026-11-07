import { createContext, type ReactNode, useContext, useMemo, useState } from "react"
import type { ViewAs } from "../api/contract.ts"

/** The identity Studio renders data through, and whether writes as that identity are unlocked. */
export interface ViewAsState {
  readonly viewAs: ViewAs | undefined
  /** Writing as the impersonated identity needs an explicit toggle and a reason, both audited. */
  readonly writeReason: string | undefined
  start(viewAs: ViewAs): void
  stop(): void
  unlockWrites(reason: string): void
  lockWrites(): void
}

const ViewAsContext = createContext<ViewAsState | null>(null)

export function ViewAsProvider({ children }: { readonly children: ReactNode }) {
  const [viewAs, setViewAs] = useState<ViewAs | undefined>(undefined)
  const [writeReason, setWriteReason] = useState<string | undefined>(undefined)
  const state = useMemo<ViewAsState>(
    () => ({
      viewAs,
      writeReason,
      start(next) {
        setViewAs(next)
        setWriteReason(undefined)
      },
      stop() {
        setViewAs(undefined)
        setWriteReason(undefined)
      },
      unlockWrites(reason) {
        if (reason.trim() !== "") setWriteReason(reason.trim())
      },
      lockWrites() {
        setWriteReason(undefined)
      },
    }),
    [viewAs, writeReason],
  )
  return <ViewAsContext.Provider value={state}>{children}</ViewAsContext.Provider>
}

export function useViewAs(): ViewAsState {
  const state = useContext(ViewAsContext)
  if (state === null) throw new TypeError("useViewAs needs a ViewAsProvider")
  return state
}

/** Builds the identity of an anonymous caller, an app user or arbitrary claims. */
export function describeViewAs(viewAs: ViewAs): string {
  if (viewAs.label !== undefined) return viewAs.label
  const subject = viewAs.claims["sub"]
  if (typeof subject === "string") return subject
  return viewAs.roles.join(", ")
}
