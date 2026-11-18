import { ChevronDownIcon } from "lucide-react"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** A styled native select: keyboard and screen reader behavior come from the browser. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        className="h-8 w-full min-w-0 cursor-default appearance-none rounded-md border border-input bg-background pr-8 pl-2.5 text-sm transition-colors hover:border-foreground/30 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-60"
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </span>
  )
}
