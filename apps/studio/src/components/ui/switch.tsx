import { Switch as SwitchPrimitive, SwitchThumb } from "@ui-sdk/react/switch"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** An on and off switch. On is the semantic green, not the brand colour. */
export function Switch({
  className,
  ...props
}: Omit<ComponentProps<typeof SwitchPrimitive>, "className"> & { readonly className?: string }) {
  return (
    <SwitchPrimitive
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 cursor-default items-center rounded-full p-0.5 transition-colors data-checked:bg-success data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchThumb className="pointer-events-none block size-3.5 rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-3.5" />
    </SwitchPrimitive>
  )
}
