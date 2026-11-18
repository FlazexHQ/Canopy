import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

const fieldClass =
  "w-full min-w-0 rounded-md border border-input bg-background text-sm transition-colors placeholder:text-muted-foreground hover:border-foreground/30 focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive"

/** A one line text field. */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClass,
        "flex h-8 px-2.5 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  )
}

/** A multi line text field. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, "flex min-h-20 px-2.5 py-2", className)}
      {...props}
    />
  )
}
