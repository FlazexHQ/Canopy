import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** A styled native select: keyboard and screen reader behavior come from the browser. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}
