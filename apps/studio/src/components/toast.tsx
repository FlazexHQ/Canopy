import { XIcon } from "lucide-react"
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"
import { t } from "../i18n/index.ts"
import { cn } from "../lib/utils.ts"

export interface ToastInput {
  readonly title: string
  readonly description?: string
  readonly variant?: "default" | "success" | "error"
}

interface ToastEntry extends ToastInput {
  readonly id: number
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null)
let nextId = 1

/** Shows short confirmations in a polite live region; errors use an assertive one. */
export function Toaster({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastEntry[]>([])
  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((toast) => toast.id !== id))
  }, [])
  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId++
      setToasts((all) => [...all.slice(-3), { ...toast, id }])
      setTimeout(() => dismiss(id), toast.variant === "error" ? 10_000 : 5_000)
    },
    [dismiss],
  )
  const value = useMemo(() => push, [push])
  const region = (variant: "polite" | "assertive") => (
    <div
      aria-live={variant}
      role={variant === "assertive" ? "alert" : "status"}
      className="flex flex-col gap-2"
    >
      {toasts
        .filter((toast) => (toast.variant === "error") === (variant === "assertive"))
        .map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
              toast.variant === "error" && "border-destructive/60",
              toast.variant === "success" && "border-success/60",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{toast.title}</p>
              {toast.description === undefined ? null : (
                <p className="mt-0.5 break-words text-muted-foreground">{toast.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="rounded-sm opacity-70 hover:opacity-100"
            >
              <XIcon className="size-4" aria-hidden="true" />
              <span className="sr-only">{t("common.close")}</span>
            </button>
          </div>
        ))}
    </div>
  )
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
        {region("assertive")}
        {region("polite")}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext)
  if (push === null) throw new TypeError("useToast needs a Toaster")
  return push
}

/** The message of an unknown error, for toasts. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
