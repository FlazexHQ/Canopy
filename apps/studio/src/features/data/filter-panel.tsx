import { PlusIcon, Trash2Icon } from "lucide-react"
import { useId, useState } from "react"
import { CodeEditor } from "../../components/code-editor.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { t } from "../../i18n/index.ts"
import { parseEjsonObject } from "../../lib/ejson.ts"
import {
  BUILDER_OPERATORS,
  type BuilderOperator,
  type Condition,
  conditionsToFilter,
  filterToConditions,
} from "./filter.ts"

/** Props of {@link FilterPanel}. */
export interface FilterPanelProps {
  readonly fields: readonly string[]
  /** Called with the filter to apply. */
  readonly onApply: (filter: Record<string, unknown>) => void
}

const EMPTY: Condition = { field: "", op: "$eq", value: "" }

/**
 * A filter builder (field, operator, value) and a JSON filter editor that stay in sync: builder edits rewrite
 * the JSON, and JSON the builder can show rewrites the builder.
 */
export function FilterPanel({ fields, onApply }: FilterPanelProps) {
  const [conditions, setConditions] = useState<readonly Condition[]>([EMPTY])
  const [text, setText] = useState("{}")
  const [tab, setTab] = useState("builder")
  const [complex, setComplex] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const fieldListId = useId()

  const fromConditions = (next: readonly Condition[]) => {
    setConditions(next)
    setComplex(false)
    setError(undefined)
    setText(JSON.stringify(conditionsToFilter(next), null, 2))
  }

  const fromText = (next: string) => {
    setText(next)
    const parsed = parseEjsonObject(next)
    if (!parsed.ok) return
    setError(undefined)
    const derived = filterToConditions(parsed.value)
    if (derived === undefined) setComplex(true)
    else {
      setComplex(false)
      setConditions(derived.length === 0 ? [EMPTY] : derived)
    }
  }

  const update = (index: number, patch: Partial<Condition>) =>
    fromConditions(
      conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    )

  const apply = () => {
    const parsed = parseEjsonObject(text.trim() === "" ? "{}" : text)
    if (!parsed.ok) {
      setError(t("data.filter.invalid", { message: parsed.message }))
      return
    }
    setError(undefined)
    onApply(parsed.value)
  }

  return (
    <section aria-labelledby={`${fieldListId}-title`} className="rounded-lg border p-3">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <datalist id={fieldListId}>
          {fields.map((field) => (
            <option key={field} value={field} />
          ))}
        </datalist>
        <Tabs value={tab} onValueChange={setTab}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id={`${fieldListId}-title`} className="text-sm font-medium">
              {t("data.filter.title")}
            </h2>
            <TabsList>
              <TabsTrigger value="builder">{t("data.filter.builder")}</TabsTrigger>
              <TabsTrigger value="json">{t("data.filter.json")}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="builder" className="grid gap-2">
            {complex ? (
              <p role="status" className="text-sm text-warning">
                {t("data.filter.tooComplex")}
              </p>
            ) : (
              <>
                {conditions.map((condition, index) => {
                  const label = t("data.filter.conditionLabel", { index: index + 1 })
                  return (
                    <fieldset key={index} className="flex flex-wrap items-end gap-2">
                      <legend className="sr-only">{label}</legend>
                      <div className="grid min-w-40 flex-1 gap-1">
                        <Label htmlFor={`${fieldListId}-f${index}`}>{t("data.filter.field")}</Label>
                        <Input
                          id={`${fieldListId}-f${index}`}
                          list={fieldListId}
                          value={condition.field}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => update(index, { field: event.target.value })}
                        />
                      </div>
                      <div className="grid w-44 gap-1">
                        <Label htmlFor={`${fieldListId}-o${index}`}>
                          {t("data.filter.operator")}
                        </Label>
                        <Select
                          value={condition.op}
                          onValueChange={(op) => update(index, { op: op as BuilderOperator })}
                        >
                          <SelectTrigger id={`${fieldListId}-o${index}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BUILDER_OPERATORS.map((op) => (
                              <SelectItem key={op} value={op}>
                                {t(`data.ops.${op}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid min-w-40 flex-1 gap-1">
                        <Label htmlFor={`${fieldListId}-v${index}`}>{t("data.filter.value")}</Label>
                        <Input
                          id={`${fieldListId}-v${index}`}
                          value={condition.value}
                          autoComplete="off"
                          spellCheck={false}
                          aria-describedby={`${fieldListId}-hint`}
                          onChange={(event) => update(index, { value: event.target.value })}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("data.filter.removeCondition", { index: index + 1 })}
                        onClick={() => {
                          const next = conditions.filter((_, i) => i !== index)
                          fromConditions(next.length === 0 ? [EMPTY] : next)
                        }}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </fieldset>
                  )
                })}
                <p id={`${fieldListId}-hint`} className="text-xs text-muted-foreground">
                  {t("data.filter.valueHint")}
                </p>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fromConditions([...conditions, EMPTY])}
                  >
                    <PlusIcon aria-hidden="true" />
                    {t("data.filter.addCondition")}
                  </Button>
                </div>
              </>
            )}
          </TabsContent>
          <TabsContent value="json">
            <CodeEditor
              value={text}
              onChange={fromText}
              label={t("data.filter.jsonLabel")}
              completion={{ fields }}
              minHeight="5rem"
              onSubmit={apply}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("data.filter.applyHint")}</p>
          </TabsContent>
        </Tabs>
        {error === undefined ? null : (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Button type="submit" size="sm">
            {t("data.filter.apply")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fromConditions([EMPTY])
              onApply({})
            }}
          >
            {t("data.filter.clear")}
          </Button>
        </div>
      </form>
    </section>
  )
}
