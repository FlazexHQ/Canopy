import {
  TooltipContent as TooltipContentPrimitive,
  Tooltip as TooltipPrimitive,
  TooltipTrigger,
} from "@ui-sdk/react/tooltip"
import type { ReactElement, ReactNode } from "react"

/** A short hint on hover or focus over `children`, which must be one focusable element. */
export function Tooltip({
  content,
  children,
  side = "top",
}: {
  readonly content: ReactNode
  readonly children: ReactElement<Record<string, unknown>>
  readonly side?: "top" | "bottom" | "left" | "right"
}) {
  return (
    <TooltipPrimitive delay={300}>
      <TooltipTrigger render={children} />
      <TooltipContentPrimitive
        side={side}
        sideOffset={6}
        className="popup-motion max-w-64 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
      >
        {content}
      </TooltipContentPrimitive>
    </TooltipPrimitive>
  )
}
