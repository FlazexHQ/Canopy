import {
  SelectContent as SelectContentPrimitive,
  SelectItemIndicator,
  SelectItem as SelectItemPrimitive,
  Select as SelectPrimitive,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
} from "@ui-sdk/react/select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/utils.ts"

type WithClass<T> = Omit<T, "className" | "children"> & {
  readonly className?: string
  readonly children?: ReactNode
}

/** Chooses one string value from a popup list. */
export function Select({
  value,
  onValueChange,
  disabled,
  placeholder,
  children,
}: {
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly disabled?: boolean
  readonly placeholder?: string
  readonly children: ReactNode
}) {
  return (
    <SelectPrimitive
      value={value}
      {...(disabled === undefined ? {} : { disabled })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onValueChange={(next: unknown) => {
        if (typeof next === "string") onValueChange(next)
      }}
    >
      {children}
    </SelectPrimitive>
  )
}

/** Shows the chosen value inside a {@link SelectTrigger}. */
export function SelectValue({
  className,
  ...props
}: WithClass<ComponentProps<typeof SelectValuePrimitive>>) {
  return (
    <SelectValuePrimitive
      className={cn("truncate data-placeholder:text-muted-foreground", className)}
      {...props}
    />
  )
}

/** The button that opens a {@link Select}. */
export function SelectTrigger({
  className,
  children,
  ...props
}: WithClass<ComponentProps<typeof SelectTriggerPrimitive>>) {
  return (
    <SelectTriggerPrimitive
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-background px-2.5 text-left text-sm transition-colors hover:border-foreground/30 data-disabled:cursor-not-allowed data-disabled:opacity-60 data-open:border-ring",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </SelectTriggerPrimitive>
  )
}

/** The popup list of a {@link Select}. */
export function SelectContent({
  className,
  ...props
}: WithClass<ComponentProps<typeof SelectContentPrimitive>>) {
  return (
    <SelectContentPrimitive
      sideOffset={4}
      className={cn(
        "popup-motion max-h-[min(20rem,var(--available-height))] min-w-(--anchor-width) overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
        className,
      )}
      {...props}
    />
  )
}

/** One option of a {@link Select}. */
export function SelectItem({
  className,
  children,
  ...props
}: WithClass<ComponentProps<typeof SelectItemPrimitive>>) {
  return (
    <SelectItemPrimitive
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectItemIndicator className="absolute right-2 flex size-4 items-center justify-center text-brand">
        <CheckIcon className="size-4" aria-hidden="true" />
      </SelectItemIndicator>
    </SelectItemPrimitive>
  )
}
