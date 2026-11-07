import { CheckIcon, CopyIcon } from "lucide-react"
import { useState } from "react"
import { t } from "../i18n/index.ts"
import { Button } from "./ui/button.tsx"

/** Copies text to the clipboard and confirms for a moment. */
export function CopyButton({
  value,
  what,
  size = "icon",
}: {
  readonly value: string
  readonly what: string
  readonly size?: "icon" | "sm"
}) {
  const [copied, setCopied] = useState(false)
  const label = copied ? t("common.copied") : t("common.copyToClipboard", { what })
  return (
    <Button
      variant="outline"
      size={size}
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {size === "sm" ? (copied ? t("common.copied") : t("common.copy")) : null}
    </Button>
  )
}

/** A block of code with a copy button. */
export function CodeBlock({ code, what }: { readonly code: string; readonly what: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 pr-12 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton value={code} what={what} />
      </div>
    </div>
  )
}
