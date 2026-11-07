import { StyleModule as Upstream } from "style-mod"

interface AdoptedSet {
  readonly sheet: CSSStyleSheet
  readonly modules: Upstream[]
}

const sets = new WeakMap<Document | ShadowRoot, AdoptedSet>()

/**
 * `style-mod` (CodeMirror's styling) with every root styled through an adopted, constructed stylesheet.
 * Upstream does that only for shadow roots and writes a `<style>` element into documents, which Studio's
 * CSP (`style-src 'self'`) blocks. Rule order follows upstream: later modules take precedence, and
 * remounting in another order moves the modules. The build aliases the package to this module.
 */
export class StyleModule extends Upstream {
  static override mount(
    root: Document | ShadowRoot,
    modules: Upstream | ReadonlyArray<Upstream>,
    _options?: { readonly nonce?: string },
  ): void {
    let set = sets.get(root)
    if (set === undefined) {
      const view = (root instanceof Document ? root : root.ownerDocument).defaultView
      if (view === null) return
      set = { sheet: new view.CSSStyleSheet(), modules: [] }
      sets.set(root, set)
    }
    let changed = false
    let next = 0
    for (const module of Array.isArray(modules) ? modules : [modules]) {
      let index = set.modules.indexOf(module)
      if (index > -1 && index < next) {
        set.modules.splice(index, 1)
        next -= 1
        index = -1
        changed = true
      }
      if (index === -1) {
        set.modules.splice(next, 0, module)
        next += 1
        changed = true
      } else next = index + 1
    }
    if (changed) set.sheet.replaceSync(set.modules.map((module) => module.getRules()).join("\n"))
    if (!root.adoptedStyleSheets.includes(set.sheet))
      root.adoptedStyleSheets = [set.sheet, ...root.adoptedStyleSheets]
  }
}
