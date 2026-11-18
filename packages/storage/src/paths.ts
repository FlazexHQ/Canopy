import { InvalidQueryError, ValidationError } from "@canopy/protocol"

const BUCKET = /^[a-z0-9][a-z0-9_-]{0,62}$/
const MAX_PATH_BYTES = 1024

/** Whether a bucket name is valid: lower case letters, digits, `_` and `-`, at most 63 characters. */
export function isBucketName(name: string): boolean {
  return BUCKET.test(name)
}

/**
 * Checks a file path: segments separated by `/`, none empty, `.` or `..`, no control characters or
 * backslashes, at most 1024 bytes. Throws {@link InvalidQueryError}.
 */
export function checkPath(path: string): void {
  if (path === "") throw new InvalidQueryError("The file path is empty")
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES)
    throw new InvalidQueryError(`The file path may not exceed ${MAX_PATH_BYTES} bytes`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000-\u001f\u007f\\]/.test(path))
    throw new InvalidQueryError("The file path may not hold control characters or backslashes")
  for (const segment of path.split("/"))
    if (segment === "" || segment === "." || segment === "..")
      throw new InvalidQueryError("The file path may not have empty, . or .. segments")
}

/** The media type of a `Content-Type` value, lower case and without parameters. */
export function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase()
}

/** Checks a content type against a bucket's allowed types (`image/png`, `image/*`; none allows any). */
export function checkType(contentType: string, allowed: readonly string[]): void {
  if (allowed.length === 0) return
  const type = mediaType(contentType)
  const ok = allowed.some((pattern) => {
    const wanted = pattern.toLowerCase()
    return wanted.endsWith("/*") ? type.startsWith(wanted.slice(0, -1)) : type === wanted
  })
  if (!ok)
    throw new ValidationError(`This bucket does not accept ${type || "files without a type"}`, {
      details: { allowedTypes: allowed },
    })
}

/** Escapes text for a regular expression that matches it literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
