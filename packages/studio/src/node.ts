import { type NodeListener, toNodeListener as serveOnNode } from "@canopy/node-http"
import type { StudioHandler } from "./handler.ts"

/**
 * Adapts a {@link StudioHandler} to `node:http` and Express. Requests outside the base path go to `next`
 * (404 without one).
 */
export function toNodeListener(handler: StudioHandler): NodeListener {
  return serveOnNode((request) => handler.fetch(request), {
    matches: (url) => handler.matches(url.pathname),
  })
}
