import { Tooltip as TooltipPrimitive } from "radix-ui"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/utils.ts"

export const TooltipProvider = TooltipPrimitive.Provider

export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-background",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

/** A tooltip on a focusable trigger. */
export function Tooltip({
  content,
  children,
}: {
  readonly content: ReactNode
  readonly children: ReactNode
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipContent>{content}</TooltipContent>
    </TooltipPrimitive.Root>
  )
}
