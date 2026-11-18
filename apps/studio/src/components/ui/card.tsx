import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** A flat panel on the sheet: a 1px edge, no shadow. */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-lg border bg-card py-4 text-card-foreground",
        className,
      )}
      {...props}
    />
  )
}

/** The title row of a {@link Card}. */
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 px-5", className)} {...props} />
}

/** The title of a {@link Card}. */
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-[15px] font-semibold leading-6", className)} {...props} />
}

/** One grey sentence under a card's title. */
export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

/** The body of a {@link Card}. */
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5", className)} {...props} />
}
