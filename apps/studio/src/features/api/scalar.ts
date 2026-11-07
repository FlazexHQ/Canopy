import { createApiReference } from "@scalar/api-reference"
import "@scalar/api-reference/style.css"

/**
 * Mounts the Scalar API reference for an OpenAPI document. Loaded lazily, because Scalar is the largest
 * dependency of Studio and only this tab needs it. Returns a function that unmounts it.
 */
export function mountReference(
  element: Element,
  spec: Readonly<Record<string, unknown>>,
  dark: boolean,
): () => void {
  const instance = createApiReference(element, {
    content: spec,
    withDefaultFonts: false,
    hideDarkModeToggle: true,
    forceDarkModeState: dark ? "dark" : "light",
    telemetry: false,
  })
  return () => instance.destroy()
}
