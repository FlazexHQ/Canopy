import { fileURLToPath } from "node:url"
import { normalizePath, type Plugin } from "vite"

/** A shim's module id as Vite writes it: with `/` separators on Windows too, so importers compare equal. */
const shim = (path: string): string => normalizePath(fileURLToPath(new URL(path, import.meta.url)))

const SHIMS: Readonly<Record<string, string>> = {
  "react-style-singleton": shim("./src/lib/style-singleton.ts"),
  "style-mod": shim("./src/lib/style-mod.ts"),
}

/** The code `vite-plugin-css-injected-by-js` puts in front of a library to add its CSS as a `<style>`. */
const INJECTED_CSS =
  /var (\w+) = document\.createElement\("style"\);\s*\1\.appendChild\(document\.createTextNode\(("(?:[^"\\]|\\.)*")\)\);\s*document\.head\.appendChild\(\1\);/g

/**
 * Keeps Studio within its CSP (`style-src 'self'`, so no `<style>` elements and no style attributes in
 * markup) without loosening it: the libraries that add CSS at runtime get it through constructed
 * stylesheets, which no CSP directive governs because nothing is parsed from markup. `react-style-singleton`
 * (Radix scroll locking) and `style-mod` (CodeMirror) resolve to shims, except from the shims themselves,
 * and the CSS that `vite-plugin-css-injected-by-js` bundles into Scalar's dependencies is adopted instead
 * of appended.
 */
export function cspStyles(): Plugin {
  const shims = new Set(Object.values(SHIMS))
  return {
    name: "canopy-studio-csp-styles",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const target = SHIMS[source]
      if (target === undefined || (importer !== undefined && shims.has(importer))) return null
      return this.resolve(target, importer, { ...options, skipSelf: true })
    },
    transform(code, id) {
      if (!id.includes("node_modules") || !code.includes('document.createElement("style")'))
        return null
      const rewritten = code.replace(
        INJECTED_CSS,
        (_match, name: string, css: string) =>
          `var ${name} = new CSSStyleSheet(); ${name}.replaceSync(${css}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, ${name}];`,
      )
      return rewritten === code ? null : { code: rewritten, map: null }
    },
  }
}
