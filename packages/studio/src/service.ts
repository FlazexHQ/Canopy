import { STUDIO_BASE_PATH } from "./handler.ts"

/**
 * The request handler of the standalone Studio service: answers `/healthz` and `/readyz` for health checks
 * and sends the bare origin to Studio, so `studio` (usually `createStudioHandler().fetch`) serves the rest.
 */
export function studioService(
  studio: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/healthz" || path === "/readyz") return new Response("ok")
    if (path === "/") return Response.redirect(new URL(`${STUDIO_BASE_PATH}/`, request.url), 302)
    return studio(request)
  }
}
