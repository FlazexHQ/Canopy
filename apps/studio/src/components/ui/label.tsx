import { Label as LabelPrimitive } from "@ui-sdk/react/label"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** Names a control; a press on it moves focus into the control. */
export function Label({
  className,
  ...props
}: Omit<ComponentProps<typeof LabelPrimitive>, "className"> & { readonly className?: string }) {
  return (
    <LabelPrimitive
      className={cn(
        "flex select-none items-center gap-2 text-sm font-medium leading-5 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}
