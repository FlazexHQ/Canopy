import { type CanopyClient, type ClientOptions, createClient } from "canopy.js"

/** Connects the way an untyped app does. */
export function connect(options: ClientOptions): CanopyClient {
  return createClient(options)
}
