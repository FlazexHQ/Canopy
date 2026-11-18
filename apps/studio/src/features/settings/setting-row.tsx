import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** One settings area as a row: what it is on the left, its controls on the right, rows split by a rule. */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="setting-row"
      className={cn(
        "grid gap-x-12 gap-y-4 border-b py-8 first:pt-0 last:border-b-0 md:grid-cols-[17rem_minmax(0,1fr)]",
        className,
      )}
      {...props}
    />
  )
}

/** The left column of a setting row: its title and what it controls. */
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-col items-start gap-1.5", className)} {...props} />
}

/** The title of a setting row. */
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-[15px] font-semibold leading-6", className)} {...props} />
}

/** What a setting row controls, in one or two grey sentences. */
export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

/** The controls of a setting row. */
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0", className)} {...props} />
}
