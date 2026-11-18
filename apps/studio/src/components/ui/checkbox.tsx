import { CheckboxIndicator, Checkbox as CheckboxPrimitive } from "@ui-sdk/react/checkbox"
import { CheckIcon } from "lucide-react"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** A checkbox. */
export function Checkbox({
  className,
  ...props
}: Omit<ComponentProps<typeof CheckboxPrimitive>, "className"> & { readonly className?: string }) {
  return (
    <CheckboxPrimitive
      className={cn(
        "peer inline-flex size-4 shrink-0 cursor-default items-center justify-center rounded-[4px] border border-input bg-background transition-colors data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxIndicator className="flex items-center justify-center text-current">
        <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
      </CheckboxIndicator>
    </CheckboxPrimitive>
  )
}
