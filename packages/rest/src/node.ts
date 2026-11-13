import { type NodeListener, toNodeListener as serveOnNode } from "@canopy/node-http"
import type { RestHandler } from "./handler.ts"

/**
 * Adapts a {@link RestHandler} to `node:http`, Express, Fastify (through its raw server) and other
 * `(req, res)` servers. Under Express the original URL is used, so `app.use('/rest/v1', listener)` keeps
 * the base path. Mount it before any body parser, which would consume the request body.
 */
export function toNodeListener(handler: RestHandler): NodeListener {
  return serveOnNode((request, info) => handler.fetch(request, info))
}
