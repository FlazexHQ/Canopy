import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-raised text-foreground",
        destructive: "bg-pill-negative text-pill-negative-ink",
        warning: "bg-pill-warning text-pill-warning-ink",
        success: "bg-pill-positive text-pill-positive-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

/** A message about the page or a block: a tinted well, no border. */
export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}

/** The first line of an {@link Alert}. */
export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("col-start-2 font-medium", className)} {...props} />
}

/** The detail of an {@link Alert}. */
export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm opacity-90 [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  )
}
