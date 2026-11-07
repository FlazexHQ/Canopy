import { readFile, stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** The path Studio is served under by default. */
export const STUDIO_BASE_PATH = "/studio"

/**
 * The Content Security Policy of every Studio response. Scripts load only from the same origin (no inline
 * scripts, no `eval`), the page cannot be framed, and requests go only to the same origin. Inline styles are
 * allowed because the component libraries set them at runtime; they cannot run code.
 */
export const STUDIO_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
}

const IMMUTABLE = "public, max-age=31536000, immutable"
const REVALIDATE = "no-cache"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
}

/** The directory holding the built Studio (`index.html` and `assets/`), shipped inside this package. */
export const studioAssetsDir: string = fileURLToPath(new URL("../app/", import.meta.url))

/** Options of {@link createStudioHandler}. */
export interface StudioHandlerOptions {
  /** The path prefix Studio is served under. Defaults to `/studio`. */
  readonly basePath?: string
  /** The built Studio directory. Defaults to {@link studioAssetsDir}. */
  readonly assetsDir?: string
  /** Replaces {@link STUDIO_CSP}. */
  readonly contentSecurityPolicy?: string
}

/** Serves the built Studio single page app. */
export interface StudioHandler {
  readonly basePath: string
  /** Whether a request path belongs to Studio. */
  matches(pathname: string): boolean
  /**
   * Answers a Studio request: hashed files under `assets/` with immutable caching, other files and the
   * `index.html` fallback of client side routes with revalidation.
   */
  fetch(request: Request): Promise<Response>
}

interface FileEntry {
  readonly body: Uint8Array
  readonly etag: string
}

function normalizeBase(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, "")
  if (!trimmed.startsWith("/") || trimmed.length < 2) {
    throw new TypeError(
      `Studio basePath must start with a slash and name a path, got "${basePath}"`,
    )
  }
  return trimmed
}

function headers(extra: Record<string, string>, csp: string): Headers {
  const result = new Headers(SECURITY_HEADERS)
  result.set("content-security-policy", csp)
  for (const [name, value] of Object.entries(extra)) result.set(name, value)
  return result
}

/** Decodes and checks a relative path, returning undefined for anything that could leave the root. */
function safeRelative(path: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined
  const parts = decoded.split("/").filter((part) => part !== "")
  if (parts.some((part) => part === ".." || part === "." || part.startsWith("."))) return undefined
  return parts.join("/")
}

/**
 * Creates the Studio handler. Responses carry the strict CSP, `X-Frame-Options: DENY` and the other security
 * headers. When the app has not been built, Studio paths answer 503 with instructions.
 */
export function createStudioHandler(options: StudioHandlerOptions = {}): StudioHandler {
  const basePath = normalizeBase(options.basePath ?? STUDIO_BASE_PATH)
  const root = resolve(options.assetsDir ?? studioAssetsDir)
  const csp = options.contentSecurityPolicy ?? STUDIO_CSP
  const immutableCache = new Map<string, FileEntry>()

  const load = async (relative: string, immutable: boolean): Promise<FileEntry | undefined> => {
    const cached = immutableCache.get(relative)
    if (cached !== undefined) return cached
    const absolute = resolve(root, relative)
    if (absolute !== root && !absolute.startsWith(root + sep)) return undefined
    try {
      const info = await stat(absolute)
      if (!info.isFile()) return undefined
      const body = new Uint8Array(await readFile(absolute))
      const entry = {
        body,
        etag: `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
      }
      if (immutable) immutableCache.set(relative, entry)
      return entry
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error) return undefined
      throw error
    }
  }

  const respond = (
    request: Request,
    entry: FileEntry,
    relative: string,
    cacheControl: string,
  ): Response => {
    const type = CONTENT_TYPES[extname(relative).toLowerCase()] ?? "application/octet-stream"
    const responseHeaders = headers(
      { "content-type": type, "cache-control": cacheControl, etag: entry.etag },
      csp,
    )
    if (request.headers.get("if-none-match") === entry.etag) {
      return new Response(null, { status: 304, headers: responseHeaders })
    }
    responseHeaders.set("content-length", String(entry.body.byteLength))
    return new Response(request.method === "HEAD" ? null : entry.body, {
      status: 200,
      headers: responseHeaders,
    })
  }

  const text = (status: number, body: string, extra: Record<string, string> = {}): Response =>
    new Response(body, {
      status,
      headers: headers(
        { "content-type": "text/plain; charset=utf-8", "cache-control": REVALIDATE, ...extra },
        csp,
      ),
    })

  return {
    basePath,
    matches(pathname) {
      return pathname === basePath || pathname.startsWith(`${basePath}/`)
    },
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
        return text(404, "Not found")
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(405, "Method not allowed", { allow: "GET, HEAD" })
      }
      if (url.pathname === basePath) {
        return new Response(null, {
          status: 308,
          headers: headers({ location: `${basePath}/${url.search}` }, csp),
        })
      }
      const relative = safeRelative(url.pathname.slice(basePath.length + 1))
      if (relative === undefined) return text(404, "Not found")
      if (relative.startsWith("assets/")) {
        const asset = await load(relative, true)
        return asset === undefined
          ? text(404, "Not found")
          : respond(request, asset, relative, IMMUTABLE)
      }
      if (relative !== "" && extname(relative) !== "" && relative !== "index.html") {
        const file = await load(relative, false)
        if (file !== undefined) return respond(request, file, relative, REVALIDATE)
        return text(404, "Not found")
      }
      const index = await load("index.html", false)
      if (index === undefined) {
        return text(
          503,
          "Canopy Studio is not built. Run `bun --filter @canopy/studio-app build` and restart the server.",
        )
      }
      return respond(request, index, "index.html", REVALIDATE)
    },
  }
}
