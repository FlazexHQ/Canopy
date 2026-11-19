import { type CanopyClient, type ClientOptions, createClient } from "@canopy/client"

/** Connects the way an untyped app does. */
export function connect(options: ClientOptions): CanopyClient {
  return createClient(options)
}
