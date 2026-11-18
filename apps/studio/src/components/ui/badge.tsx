import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** The classes of a status pill: a pale tint with dark text of the same hue. */
export const badgeVariants = cva(
  "inline-flex h-5 w-fit flex-none shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium leading-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-brand-soft text-brand",
        secondary: "bg-pill-neutral text-pill-neutral-ink",
        destructive: "bg-pill-negative text-pill-negative-ink",
        warning: "bg-pill-warning text-pill-warning-ink",
        success: "bg-pill-positive text-pill-positive-ink",
        outline: "border border-border text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

/** A short status or category label. */
export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}
