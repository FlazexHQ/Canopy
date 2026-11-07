import { type ReactNode, useId, useState } from "react"
import { t } from "../i18n/index.ts"
import { Button } from "./ui/button.tsx"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx"
import { Input, Textarea } from "./ui/input.tsx"
import { Label } from "./ui/label.tsx"

/** Props of {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly confirmLabel: string
  readonly destructive?: boolean
  /** When set, the action stays disabled until this exact text is typed. */
  readonly typedConfirmation?: string
  /** Asks for a reason (or comment) that goes to the audit log. */
  readonly reason?: { readonly label: string; readonly required: boolean; readonly hint?: string }
  readonly pending?: boolean
  readonly onConfirm: (input: { readonly reason: string; readonly typed: string }) => void
  readonly children?: ReactNode
}

/** A confirmation for dangerous or audited actions, optionally with typed confirmation and a reason. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  typedConfirmation,
  reason,
  pending = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("")
  const [reasonText, setReasonText] = useState("")
  const typedId = useId()
  const reasonId = useId()
  const reasonHintId = useId()
  const typedOk = typedConfirmation === undefined || typed === typedConfirmation
  const reasonOk = reason === undefined || !reason.required || reasonText.trim() !== ""
  const close = (next: boolean) => {
    if (!next) {
      setTyped("")
      setReasonText("")
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (typedOk && reasonOk && !pending) onConfirm({ reason: reasonText.trim(), typed })
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description === undefined ? null : (
              <DialogDescription>{description}</DialogDescription>
            )}
          </DialogHeader>
          {children}
          {reason === undefined ? null : (
            <div className="grid gap-2">
              <Label htmlFor={reasonId}>
                {reason.label}
                {reason.required ? null : (
                  <span className="font-normal text-muted-foreground">
                    ({t("common.optional")})
                  </span>
                )}
              </Label>
              <Textarea
                id={reasonId}
                value={reasonText}
                required={reason.required}
                aria-describedby={reasonHintId}
                onChange={(event) => setReasonText(event.target.value)}
              />
              <p id={reasonHintId} className="text-xs text-muted-foreground">
                {reason.hint ?? t("common.reasonHint")}
              </p>
            </div>
          )}
          {typedConfirmation === undefined ? null : (
            <div className="grid gap-2">
              <Label htmlFor={typedId}>
                {t("common.typeToConfirm", { value: typedConfirmation })}
              </Label>
              <Input
                id={typedId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={typed !== "" && !typedOk}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={!typedOk || !reasonOk || pending}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
