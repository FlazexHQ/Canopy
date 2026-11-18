import { watch } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  CONTEXT_DOCUMENT_ID,
  type CollectionPolicies,
  type ContextDefinitions,
  contextsFromStored,
  createPolicySet,
  fromStored,
  type PolicySet,
} from "@canopy/policy"
import { isDocument, parse } from "@canopy/protocol"
import type { ChangeStream, Db, MongoClient } from "mongodb"

function moduleSpecifier(file: string, version: number): string {
  // The query defeats the module cache on reload; Bun ignores it on a file URL but not on a path.
  const bun = (globalThis as { Bun?: unknown }).Bun !== undefined
  return bun ? `${file}?v=${version}` : `${pathToFileURL(file).href}?v=${version}`
}

/** Where policies come from. A source with `watch` supports hot reload. */
export interface PolicySource {
  load(): Promise<PolicySet>
  /** Calls `onChange` with every new valid set. Invalid changes are reported to `onError` and ignored. */
  watch?(onChange: (set: PolicySet) => void, onError: (error: unknown) => void): () => void
}

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"])

function isCollectionPolicies(value: unknown): value is CollectionPolicies {
  return (
    isDocument(value) && typeof value["collection"] === "string" && Array.isArray(value["policies"])
  )
}

/** A fixed policy set, for embedding and tests. */
export function staticPolicies(set: PolicySet): PolicySource {
  return { load: async () => set }
}

/**
 * Loads policies from a directory: TypeScript or JavaScript modules whose default export is a `collection(...)`
 * (or an array of them), JSON files in the stored form, and `_context.*` for context lookups. Test files are
 * skipped. With `watch`, the directory is reloaded when files change, and a set that fails validation is
 * rejected while the previous one stays active.
 */
export function directoryPolicies(dir: string): PolicySource {
  const root = resolve(dir)
  const load = async (): Promise<PolicySet> => {
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !/\.(?:test|spec)\./.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    const definitions: CollectionPolicies[] = []
    let contexts: ContextDefinitions = {}
    const version = Date.now()
    for (const name of entries) {
      const file = join(root, name)
      const extension = extname(name)
      let exported: unknown
      if (extension === ".json") {
        exported = parse(await readFile(file, "utf8"))
        if (isDocument(exported) && typeof exported["_id"] === "string") {
          if (exported["_id"] === CONTEXT_DOCUMENT_ID) {
            contexts = (exported["lookups"] ?? {}) as ContextDefinitions
            continue
          }
          exported = fromStored(exported)
        }
      } else if (MODULE_EXTENSIONS.has(extension)) {
        const module: unknown = await import(moduleSpecifier(file, version))
        exported = isDocument(module) ? module["default"] : undefined
      } else {
        continue
      }
      if (name.startsWith("_context.")) {
        if (!isDocument(exported)) throw new TypeError(`${name} must export context lookups`)
        contexts = exported as ContextDefinitions
        continue
      }
      const list = Array.isArray(exported) ? exported : [exported]
      for (const item of list) {
        if (!isCollectionPolicies(item))
          throw new TypeError(`${name} must export collection(...) policies`)
        definitions.push(item)
      }
    }
    return createPolicySet(definitions, contexts)
  }
  return {
    load,
    watch(onChange, onError) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const watcher = watch(root, () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          load().then(onChange, onError)
        }, 200)
      })
      return () => {
        if (timer !== undefined) clearTimeout(timer)
        watcher.close()
      }
    },
  }
}

/**
 * Loads policies from the meta database (`canopy.policies`) and hot reloads them through a change stream,
 * which is reopened (followed by a full reload) when it fails.
 */
export function databasePolicies(client: MongoClient, metaDatabase = "canopy"): PolicySource {
  const db: Db = client.db(metaDatabase)
  const load = async (): Promise<PolicySet> => {
    const docs: unknown[] = await db.collection("policies").find({}).toArray()
    const definitions: CollectionPolicies[] = []
    let contexts: ContextDefinitions = {}
    for (const doc of docs) {
      if (isDocument(doc) && doc["_id"] === CONTEXT_DOCUMENT_ID) {
        contexts = contextsFromStored(doc["lookups"])
        continue
      }
      definitions.push(fromStored(doc))
    }
    return createPolicySet(definitions, contexts)
  }
  return {
    load,
    watch(onChange, onError) {
      let stream: ChangeStream | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      const reload = (): void => {
        load().then(onChange, onError)
      }
      const open = (): void => {
        const current = db.collection("policies").watch([])
        stream = current
        current.on("change", reload)
        current.on("error", (error: unknown) => {
          onError(error)
          current.close().catch(() => {})
          if (stopped) return
          retry = setTimeout(() => {
            open()
            reload()
          }, 1000)
        })
      }
      open()
      return () => {
        stopped = true
        if (retry !== undefined) clearTimeout(retry)
        stream?.close().catch(onError)
      }
    },
  }
}
