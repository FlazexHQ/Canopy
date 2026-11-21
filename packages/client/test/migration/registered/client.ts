import { type CanopyClient, type ClientOptions, createClient } from "@canopy/client"
import { schema } from "./canopy.schema.ts"

/** Connects the way an app with a registered `canopy.schema.ts` does. */
export function connect(options: ClientOptions): CanopyClient {
  return createClient({ ...options, schema })
}
