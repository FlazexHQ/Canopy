import { useEffect } from "react"

/**
 * A drop in for `react-style-singleton`, which Radix uses (through `react-remove-scroll`) to lock page
 * scrolling while a dialog, menu or select is open. The original writes a `<style>` element, which Studio's
 * CSP (`style-src 'self'`) blocks; this one adopts a constructed stylesheet, which the CSP does not govern
 * because no markup is parsed. The build aliases the package to this module.
 */
export function stylesheetSingleton(): { add(style: string): void; remove(): void } {
  let counter = 0
  let sheet: CSSStyleSheet | undefined
  return {
    add(style) {
      if (counter === 0 && typeof document !== "undefined") {
        const created = new CSSStyleSheet()
        created.replaceSync(style)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, created]
        sheet = created
      }
      counter += 1
    },
    remove() {
      counter -= 1
      if (counter === 0 && sheet !== undefined) {
        const done = sheet
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== done)
        sheet = undefined
      }
    },
  }
}

/** A hook that adds styles while at least one component using it is mounted. */
export function styleHookSingleton(): (styles: string, isDynamic?: boolean) => void {
  const sheet = stylesheetSingleton()
  return (styles, isDynamic) => {
    const key = isDynamic === true ? styles : false
    useEffect(() => {
      sheet.add(styles)
      return () => sheet.remove()
    }, [key])
  }
}

/** A component that adds styles while at least one instance is mounted. */
export function styleSingleton(): (props: {
  readonly styles: string
  readonly dynamic?: boolean
}) => null {
  const useStyle = styleHookSingleton()
  return function Sheet({ styles, dynamic }) {
    useStyle(styles, dynamic)
    return null
  }
}
