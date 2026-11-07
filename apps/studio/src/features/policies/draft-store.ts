import { useCallback, useMemo, useState } from "react"
import type { PolicyDraft } from "../../api/client.ts"
import type { StoredCollection } from "../../api/contract.ts"
import { draftOf, sameDraft } from "./model.ts"

const PREFIX = "canopy-studio-policy-draft:"

/** A draft kept in the browser, with the published version it started from. */
interface StoredDraft {
  readonly draft: PolicyDraft
  readonly baseVersion: number
}

function load(collection: string): StoredDraft | undefined {
  try {
    const text = localStorage.getItem(PREFIX + collection)
    if (text === null) return undefined
    const value = JSON.parse(text) as unknown
    if (typeof value !== "object" || value === null) return undefined
    const { draft, baseVersion } = value as { draft?: unknown; baseVersion?: unknown }
    if (typeof baseVersion !== "number" || typeof draft !== "object" || draft === null)
      return undefined
    if ((draft as { _id?: unknown })._id !== collection) return undefined
    if (!Array.isArray((draft as { policies?: unknown }).policies)) return undefined
    return { draft: draft as PolicyDraft, baseVersion }
  } catch {
    return undefined
  }
}

function save(collection: string, value: StoredDraft | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + collection)
    else localStorage.setItem(PREFIX + collection, JSON.stringify(value))
  } catch {
    // Storage may be full or unavailable; the draft then lives only in memory.
  }
}

/** The editing state of one collection's policies. */
export interface DraftState {
  readonly draft: PolicyDraft
  /** The published version the draft is based on, sent as `expectedVersion` when publishing. */
  readonly baseVersion: number
  /** Whether the draft differs from the published version. */
  readonly dirty: boolean
  setDraft(next: PolicyDraft): void
  /** Moves the draft onto another published version, keeping its content. */
  rebase(version: number): void
  discard(): void
}

/**
 * Keeps an unpublished draft per collection in `localStorage`, so it survives reloads. Without a stored
 * draft the published version is the draft.
 */
export function useDraft(collection: string, published: StoredCollection | null): DraftState {
  const [stored, setStored] = useState<StoredDraft | undefined>(() => load(collection))
  const base = useMemo(() => draftOf(published, collection), [published, collection])
  const publishedVersion = published?.version ?? 0
  const draft = stored?.draft ?? base
  const baseVersion = stored?.baseVersion ?? publishedVersion
  const update = useCallback(
    (next: StoredDraft | undefined) => {
      save(collection, next)
      setStored(next)
    },
    [collection],
  )
  return {
    draft,
    baseVersion,
    dirty: stored !== undefined && !sameDraft(stored.draft, base),
    setDraft: (next) => update({ draft: next, baseVersion }),
    rebase: (version) => update({ draft, baseVersion: version }),
    discard: () => update(undefined),
  }
}
