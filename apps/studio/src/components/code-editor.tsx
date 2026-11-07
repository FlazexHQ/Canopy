import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language"
import { type Diagnostic, linter, lintGutter } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from "@codemirror/view"
import { tags } from "@lezer/highlight"
import { useEffect, useRef } from "react"
import { parseEjson } from "../lib/ejson.ts"
import { cn } from "../lib/utils.ts"

/** Query and update operators offered by autocomplete, with a short description each. */
const OPERATOR_COMPLETIONS: readonly (readonly [string, string])[] = [
  ["$eq", "equals"],
  ["$ne", "not equal"],
  ["$gt", "greater than"],
  ["$gte", "greater than or equal"],
  ["$lt", "less than"],
  ["$lte", "less than or equal"],
  ["$in", "in array"],
  ["$nin", "not in array"],
  ["$exists", "field exists"],
  ["$type", "BSON type"],
  ["$and", "all clauses match"],
  ["$or", "any clause matches"],
  ["$nor", "no clause matches"],
  ["$not", "negates an operator"],
  ["$all", "array contains all"],
  ["$elemMatch", "an element matches"],
  ["$size", "array length"],
  ["$mod", "modulo"],
  ["$regex", "regular expression"],
  ["$options", "regular expression flags"],
  ["$expr", "aggregation expression (check only)"],
  ["$jsonSchema", "JSON Schema (check only)"],
]

/** Extended JSON wrappers for BSON types. */
const EJSON_COMPLETIONS: readonly (readonly [string, string])[] = [
  ["$oid", "ObjectId"],
  ["$date", "Date"],
  ["$numberLong", "64 bit integer"],
  ["$numberDecimal", "Decimal128"],
  ["$uuid", "UUID"],
  ["$binary", "binary data"],
  ["$regularExpression", "regular expression"],
]

/** Policy variables, offered in policy clauses only. */
const VARIABLE_COMPLETIONS: readonly (readonly [string, string])[] = [
  ["$auth", "a JWT claim, for example sub"],
  ["$ctx", "a context lookup"],
  ["$now", "the request time"],
]

/** Options of the autocomplete source. */
export interface CompletionOptions {
  readonly fields?: readonly string[]
  readonly variables?: boolean
}

/**
 * Completes inside JSON property names: field names from the collection schema, query operators, EJSON
 * wrappers and, in policies, the `$auth`, `$ctx` and `$now` variables.
 */
function ejsonCompletionSource(options: CompletionOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    const inString = node.name === "String" || node.name === "PropertyName"
    const word = context.matchBefore(inString ? /"[\w$.]*/ : /[\w$.]+/)
    if (word === null && !context.explicit) return null
    const from = word?.from ?? context.pos
    const quoted = word?.text.startsWith('"') === true
    const closed = quoted && context.state.sliceDoc(context.pos, context.pos + 1) === '"'
    const make = (label: string, detail: string, type: string): Completion => ({
      label: quoted ? `"${label}` : label,
      displayLabel: label,
      detail,
      type,
      apply: closed ? `"${label}` : `"${label}"`,
    })
    const completions: Completion[] = [
      ...(options.fields ?? []).map((field) => make(field, "field", "property")),
      ...OPERATOR_COMPLETIONS.map(([label, detail]) => make(label, detail, "keyword")),
      ...EJSON_COMPLETIONS.map(([label, detail]) => make(label, detail, "type")),
      ...(options.variables === true
        ? VARIABLE_COMPLETIONS.map(([label, detail]) => make(label, detail, "variable"))
        : []),
    ]
    return { from, options: completions, validFor: /^"?[\w$.]*"?$/ }
  }
}

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--primary)" },
  { tag: tags.string, color: "oklch(0.55 0.12 250)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(0.6 0.15 40)" },
  { tag: tags.comment, color: "var(--muted-foreground)" },
])

const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--input)",
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
  },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "2px" },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--accent) 50%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
})

function ejsonLinter(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString()
  if (text.trim() === "") return []
  const result = parseEjson(text)
  if (result.ok) return []
  let from = 0
  if (result.line !== undefined) {
    const line = view.state.doc.line(Math.min(result.line, view.state.doc.lines))
    from = Math.min(line.from + Math.max((result.column ?? 1) - 1, 0), line.to)
  }
  return [
    {
      from,
      to: Math.min(from + 1, view.state.doc.length),
      severity: "error",
      message: result.message,
    },
  ]
}

/** Props of {@link CodeEditor}. */
export interface CodeEditorProps {
  readonly value: string
  readonly onChange?: (value: string) => void
  /** `ejson` adds JSON highlighting, linting and completion; `text` is plain monospace. */
  readonly language?: "ejson" | "text"
  readonly readOnly?: boolean
  /** The accessible name of the editing area. */
  readonly label: string
  readonly completion?: CompletionOptions
  readonly placeholder?: string
  readonly className?: string
  readonly minHeight?: string
  readonly maxHeight?: string
  /** Runs on Mod-Enter, for example to apply a filter. */
  readonly onSubmit?: () => void
  readonly id?: string
}

/**
 * A CodeMirror 6 editor for EJSON (filters, documents, policy clauses). Tab is left to the browser so
 * keyboard users can move on; indentation follows Enter.
 */
export function CodeEditor({
  value,
  onChange,
  language = "ejson",
  readOnly = false,
  label,
  completion,
  placeholder,
  className,
  minHeight = "6rem",
  maxHeight = "28rem",
  onSubmit,
  id,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSubmit })
  callbacks.current = { onChange, onSubmit }
  const completionCompartment = useRef(new Compartment())
  const fieldsKey = JSON.stringify(completion ?? {})

  useEffect(() => {
    if (host.current === null) return
    const extensions: Extension[] = [
      theme,
      lineNumbers(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({
        "aria-label": label,
        "aria-multiline": "true",
        ...(readOnly ? { "aria-readonly": "true" } : {}),
        ...(id === undefined ? {} : { id }),
      }),
      EditorView.theme({
        "&": { minHeight, maxHeight },
        ".cm-scroller": { overflow: "auto", minHeight },
      }),
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            callbacks.current.onSubmit?.()
            return callbacks.current.onSubmit !== undefined
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...completionKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString())
      }),
    ]
    if (placeholder !== undefined) extensions.push(placeholderExtension(placeholder))
    if (language === "ejson") {
      extensions.push(json(), linter(ejsonLinter, { delay: 300 }), lintGutter())
      extensions.push(
        completionCompartment.current.of(
          autocompletion({ override: [ejsonCompletionSource(completion ?? {})] }),
        ),
      )
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [language, readOnly, label])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    const current = editor.state.doc.toString()
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    const editor = view.current
    if (editor === null || language !== "ejson") return
    editor.dispatch({
      effects: completionCompartment.current.reconfigure(
        autocompletion({ override: [ejsonCompletionSource(completion ?? {})] }),
      ),
    })
  }, [fieldsKey, language])

  return <div ref={host} className={cn("text-sm", className)} data-testid="code-editor" />
}
