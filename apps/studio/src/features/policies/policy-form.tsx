import { canonicalString } from "@canopy/protocol"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useEffect, useId, useState } from "react"
import type { PolicyDraft } from "../../api/client.ts"
import type { StoredPolicy } from "../../api/contract.ts"
import { CodeEditor } from "../../components/code-editor.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Checkbox } from "../../components/ui/checkbox.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { NativeSelect } from "../../components/ui/native-select.tsx"
import { Switch } from "../../components/ui/switch.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { t } from "../../i18n/index.ts"
import { formatEjson, parseEjsonObject } from "../../lib/ejson.ts"
import { cn } from "../../lib/utils.ts"

const OPS = ["read", "insert", "update", "delete"] as const
const FIELD_KINDS = ["read", "write", "update"] as const
type FieldKind = (typeof FIELD_KINDS)[number]
type FieldRules = Readonly<
  Record<string, { readonly only?: readonly string[]; readonly omit?: readonly string[] }>
>

/** Splits a comma separated list, dropping empty entries. */
export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
}

/** A text input for a comma separated list that keeps what is typed while it parses to the same list. */
function ListInput({
  id,
  value,
  onValue,
  describedBy,
  disabled,
}: {
  readonly id: string
  readonly value: readonly string[]
  readonly onValue: (value: string[]) => void
  readonly describedBy?: string
  readonly disabled?: boolean
}) {
  const [text, setText] = useState(value.join(", "))
  const joined = value.join("\u0000")
  useEffect(() => {
    setText((current) =>
      splitList(current).join("\u0000") === joined ? current : joined.split("\u0000").join(", "),
    )
  }, [joined])
  return (
    <Input
      id={id}
      value={text}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      onChange={(event) => {
        setText(event.target.value)
        onValue(splitList(event.target.value))
      }}
    />
  )
}

/** An EJSON editor for one clause. Only text that parses reaches the draft; the error stays visible. */
function ClauseEditor({
  label,
  hint,
  value,
  fields,
  onValue,
  readOnly,
}: {
  readonly label: string
  readonly hint: string
  readonly value: string | undefined
  readonly fields: readonly string[]
  readonly onValue: (value: string | undefined) => void
  readonly readOnly: boolean
}) {
  const [text, setText] = useState(() =>
    value === undefined ? "" : formatEjson(JSON.parse(value) as unknown),
  )
  const [error, setError] = useState<string | undefined>(undefined)
  const hintId = useId()
  const errorId = useId()
  return (
    <div className="grid gap-1.5">
      <span className="font-mono text-sm font-medium">{label}</span>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
      <CodeEditor
        label={label}
        value={text}
        readOnly={readOnly}
        placeholder="{ }"
        minHeight="4rem"
        completion={{ fields, variables: true }}
        onChange={(next) => {
          setText(next)
          if (next.trim() === "") {
            setError(undefined)
            onValue(undefined)
            return
          }
          const parsed = parseEjsonObject(next)
          if (parsed.ok) {
            setError(undefined)
            onValue(canonicalString(JSON.parse(next) as unknown))
          } else setError(parsed.message)
        }}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function PolicyFields({
  policy,
  index,
  fields,
  readOnly,
  onChange,
}: {
  readonly policy: StoredPolicy
  readonly index: number
  readonly fields: readonly string[]
  readonly readOnly: boolean
  readonly onChange: (next: StoredPolicy) => void
}) {
  const id = useId()
  const usesUsing = policy.ops.some((op) => op !== "insert")
  const usesCheck = policy.ops.some((op) => op === "insert" || op === "update")
  return (
    <div className="grid gap-4" data-testid={`policy-form-${index}`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>{t("policies.editor.name")}</Label>
          <Input
            id={`${id}-name`}
            value={policy.name}
            disabled={readOnly}
            onChange={(event) => onChange({ ...policy, name: event.target.value })}
          />
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">{t("policies.editor.kind")}</legend>
          <div className="flex gap-4" aria-describedby={`${id}-kind-hint`}>
            {(["permissive", "restrictive"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={kind}
                  checked={policy.kind === kind}
                  disabled={readOnly}
                  className="accent-primary"
                  onChange={() => onChange({ ...policy, kind })}
                />
                {t(`policies.editor.${kind}`)}
              </label>
            ))}
          </div>
          <p id={`${id}-kind-hint`} className="text-xs text-muted-foreground">
            {t("policies.editor.kindHint")}
          </p>
        </fieldset>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t("policies.editor.operations")}</legend>
          <div className="flex flex-wrap gap-4">
            {OPS.map((op) => (
              <div key={op} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-op-${op}`}
                  checked={policy.ops.includes(op)}
                  disabled={readOnly}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...policy,
                      ops:
                        checked === true
                          ? OPS.filter(
                              (candidate) => candidate === op || policy.ops.includes(candidate),
                            )
                          : policy.ops.filter((candidate) => candidate !== op),
                    })
                  }
                />
                <Label htmlFor={`${id}-op-${op}`} className="font-normal">
                  {op}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-roles`}>{t("policies.editor.roles")}</Label>
          <ListInput
            id={`${id}-roles`}
            value={policy.roles}
            describedBy={`${id}-roles-hint`}
            disabled={readOnly}
            onValue={(roles) => onChange({ ...policy, roles })}
          />
          <p id={`${id}-roles-hint`} className="text-xs text-muted-foreground">
            {t("policies.editor.rolesHint")}
          </p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={cn(!usesUsing && "opacity-60")}>
          <ClauseEditor
            label={t("policies.editor.using")}
            hint={usesUsing ? t("policies.editor.usingHint") : t("policies.editor.clauseNotUsed")}
            value={policy.using}
            fields={fields}
            readOnly={readOnly}
            onValue={(using) => {
              const { using: _old, ...rest } = policy
              onChange(using === undefined ? rest : { ...rest, using })
            }}
          />
        </div>
        <div className={cn(!usesCheck && "opacity-60")}>
          <ClauseEditor
            label={t("policies.editor.check")}
            hint={usesCheck ? t("policies.editor.checkHint") : t("policies.editor.clauseNotUsed")}
            value={policy.check}
            fields={fields}
            readOnly={readOnly}
            onValue={(check) => {
              const { check: _old, ...rest } = policy
              onChange(check === undefined ? rest : { ...rest, check })
            }}
          />
        </div>
      </div>
    </div>
  )
}

function FieldRulesEditor({
  kind,
  rules,
  readOnly,
  onChange,
}: {
  readonly kind: FieldKind
  readonly rules: FieldRules | undefined
  readonly readOnly: boolean
  readonly onChange: (rules: FieldRules | undefined) => void
}) {
  const id = useId()
  const entries = Object.entries(rules ?? {})
  const kindLabel = t(`policies.editor.fieldKind.${kind}`)
  const write = (next: [string, { only?: readonly string[]; omit?: readonly string[] }][]) =>
    onChange(next.length === 0 ? undefined : Object.fromEntries(next))
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{kindLabel}</legend>
      {entries.map(([role, rule], index) => {
        const mode = rule.only === undefined ? "omit" : "only"
        const list = rule.only ?? rule.omit ?? []
        const rowId = `${id}-${index}`
        return (
          <div key={rowId} className="grid grid-cols-[1fr_7rem_2fr_auto] items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor={`${rowId}-role`} className="text-xs">
                {t("policies.editor.ruleRole")}
              </Label>
              <Input
                id={`${rowId}-role`}
                value={role}
                disabled={readOnly}
                onChange={(event) =>
                  write(
                    entries.map((entry, i) => (i === index ? [event.target.value, rule] : entry)),
                  )
                }
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${rowId}-mode`} className="text-xs">
                {t("policies.editor.ruleMode")}
              </Label>
              <NativeSelect
                id={`${rowId}-mode`}
                value={mode}
                disabled={readOnly}
                onChange={(event) =>
                  write(
                    entries.map((entry, i) =>
                      i === index
                        ? [role, event.target.value === "only" ? { only: list } : { omit: list }]
                        : entry,
                    ),
                  )
                }
              >
                <option value="only">{t("policies.editor.ruleOnly")}</option>
                <option value="omit">{t("policies.editor.ruleOmit")}</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${rowId}-fields`} className="text-xs">
                {t("policies.editor.ruleFields")}
              </Label>
              <ListInput
                id={`${rowId}-fields`}
                value={list}
                disabled={readOnly}
                onValue={(fields) =>
                  write(
                    entries.map((entry, i) =>
                      i === index
                        ? [role, mode === "only" ? { only: fields } : { omit: fields }]
                        : entry,
                    ),
                  )
                }
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              disabled={readOnly}
              aria-label={t("policies.editor.removeRule", { kind: kindLabel, role })}
              onClick={() => write(entries.filter((_, i) => i !== index))}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        )
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={() =>
            write([
              ...entries,
              [entries.some(([role]) => role === "default") ? "" : "default", { omit: [] }],
            ])
          }
        >
          <PlusIcon aria-hidden="true" />
          {t("policies.editor.addRule", { kind: kindLabel })}
        </Button>
      </div>
    </fieldset>
  )
}

/** Props of {@link PolicyForm}. */
export interface PolicyFormProps {
  readonly draft: PolicyDraft
  readonly fields: readonly string[]
  readonly readOnly: boolean
  readonly onChange: (draft: PolicyDraft) => void
  /** Changes when the draft is replaced from outside the form, so clause editors reload their text. */
  readonly revision: number
}

/** The form view: collection settings, one tab per policy, field rules and immutable fields. */
export function PolicyForm({ draft, fields, readOnly, onChange, revision }: PolicyFormProps) {
  const id = useId()
  const [selected, setSelected] = useState("0")
  const index = Math.min(Number(selected), Math.max(draft.policies.length - 1, 0))
  const setPolicies = (policies: StoredPolicy[]) => onChange({ ...draft, policies })
  const move = (from: number, to: number) => {
    const policies = [...draft.policies]
    const [item] = policies.splice(from, 1)
    if (item === undefined) return
    policies.splice(to, 0, item)
    setPolicies(policies)
    setSelected(String(to))
  }
  const setFieldRules = (kind: FieldKind, rules: FieldRules | undefined) => {
    const current = { ...(draft.fields ?? {}) } as Record<string, FieldRules | undefined>
    if (rules === undefined) delete current[kind]
    else current[kind] = rules
    const { fields: _old, ...rest } = draft
    onChange(Object.keys(current).length === 0 ? rest : { ...rest, fields: current })
  }
  return (
    <div className="grid gap-6">
      <section aria-labelledby={`${id}-collection`} className="grid gap-3">
        <h3 id={`${id}-collection`} className="text-sm font-semibold">
          {t("policies.editor.collectionSettings")}
        </h3>
        <div className="flex flex-wrap gap-6">
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-exposed`}
              checked={draft.exposed}
              disabled={readOnly}
              onCheckedChange={(exposed) => onChange({ ...draft, exposed })}
            />
            <Label htmlFor={`${id}-exposed`}>{t("policies.editor.exposed")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-realtime`}
              checked={draft.realtime}
              disabled={readOnly}
              onCheckedChange={(realtime) => onChange({ ...draft, realtime })}
            />
            <Label htmlFor={`${id}-realtime`}>{t("policies.editor.realtime")}</Label>
          </div>
        </div>
      </section>

      <section aria-labelledby={`${id}-policies`} className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${id}-policies`} className="text-sm font-semibold">
            {t("policies.editor.policyList")}
          </h3>
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => {
              setPolicies([
                ...draft.policies,
                {
                  name: t("policies.editor.newPolicyName", { n: draft.policies.length + 1 }),
                  kind: "permissive",
                  ops: ["read"],
                  roles: ["authenticated"],
                },
              ])
              setSelected(String(draft.policies.length))
            }}
          >
            <PlusIcon aria-hidden="true" />
            {t("policies.editor.addPolicy")}
          </Button>
        </div>
        {draft.policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("policies.editor.noPolicies")}</p>
        ) : (
          <Tabs value={String(index)} onValueChange={setSelected}>
            <TabsList className="h-auto flex-wrap justify-start">
              {draft.policies.map((policy, i) => (
                <TabsTrigger key={i} value={String(i)} className="flex-none">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 rounded-full",
                      policy.kind === "permissive" ? "bg-success" : "bg-warning",
                    )}
                  />
                  {policy.name === "" ? `#${i + 1}` : policy.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {draft.policies.map((policy, i) => (
              <TabsContent
                key={`${revision}:${i}`}
                value={String(i)}
                className="mt-4 grid gap-4 rounded-lg border p-4"
              >
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={readOnly || i === 0}
                    aria-label={t("policies.editor.moveUp", { name: policy.name })}
                    onClick={() => move(i, i - 1)}
                  >
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={readOnly || i === draft.policies.length - 1}
                    aria-label={t("policies.editor.moveDown", { name: policy.name })}
                    onClick={() => move(i, i + 1)}
                  >
                    <ArrowDownIcon aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={readOnly}
                    aria-label={t("policies.editor.removePolicy", { name: policy.name })}
                    onClick={() => {
                      setPolicies(draft.policies.filter((_, j) => j !== i))
                      setSelected(String(Math.max(i - 1, 0)))
                    }}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
                <PolicyFields
                  policy={policy}
                  index={i}
                  fields={fields}
                  readOnly={readOnly}
                  onChange={(next) =>
                    setPolicies(draft.policies.map((p, j) => (j === i ? next : p)))
                  }
                />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </section>

      <section aria-labelledby={`${id}-fields`} className="grid gap-3">
        <h3 id={`${id}-fields`} className="text-sm font-semibold">
          {t("policies.editor.fieldRules")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("policies.editor.fieldRulesHint")}</p>
        {FIELD_KINDS.map((kind) => (
          <FieldRulesEditor
            key={`${revision}:${kind}`}
            kind={kind}
            rules={draft.fields?.[kind]}
            readOnly={readOnly}
            onChange={(rules) => setFieldRules(kind, rules)}
          />
        ))}
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-immutable`}>{t("policies.editor.immutable")}</Label>
          <ListInput
            id={`${id}-immutable`}
            value={draft.immutable ?? []}
            describedBy={`${id}-immutable-hint`}
            disabled={readOnly}
            onValue={(immutable) => {
              const { immutable: _old, ...rest } = draft
              onChange(immutable.length === 0 ? rest : { ...rest, immutable })
            }}
          />
          <p id={`${id}-immutable-hint`} className="text-xs text-muted-foreground">
            {t("policies.editor.immutableHint")}
          </p>
        </div>
      </section>
    </div>
  )
}
