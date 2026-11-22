import { type CanopyClient, type ClientOptions, createClient } from "canopy.js"
import type { Database } from "./canopy.gen.ts"

/** Connects the way an app typed by `canopy gen types` did before the schema file. */
export function connect(options: ClientOptions): CanopyClient<Database> {
  return createClient<Database>(options)
}
