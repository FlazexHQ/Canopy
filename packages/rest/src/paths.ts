import { isDocument } from "@canopy/protocol"

/**
 * Lists the paths a stored document writes, down to its leaves. Subdocuments, including those inside
 * arrays, are walked so that field rules such as `only: ['profile.name']` can allow `{ profile: { name } }`.
 * An empty subdocument or array counts as a write of its own path.
 */
export function leafPaths(doc: Record<string, unknown>): string[] {
  const out = new Set<string>()
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      const docs = value.filter((item) => isDocument(item))
      if (docs.length === 0 || docs.length < value.length) out.add(path)
      for (const item of docs) walk(item, path)
      return
    }
    if (!isDocument(value)) {
      out.add(path)
      return
    }
    const keys = Object.keys(value).filter((key) => value[key] !== undefined)
    if (keys.length === 0) out.add(path)
    for (const key of keys) walk(value[key], `${path}.${key}`)
  }
  for (const key of Object.keys(doc)) {
    if (doc[key] !== undefined) walk(doc[key], key)
  }
  return [...out]
}
