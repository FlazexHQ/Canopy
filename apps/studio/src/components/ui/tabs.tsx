import {
  TabsList as TabsListPrimitive,
  TabsPanel,
  Tabs as TabsPrimitive,
  TabsTab,
} from "@ui-sdk/react/tabs"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/utils.ts"

type WithClass<T> = Omit<T, "className"> & { readonly className?: string }

/** Switches between views that share one place, controlled or uncontrolled. */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
}: {
  readonly value?: string
  readonly defaultValue?: string
  readonly onValueChange?: (value: string) => void
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <TabsPrimitive
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      onValueChange={(next: unknown) => {
        if (typeof next === "string") onValueChange?.(next)
      }}
      className={cn("flex flex-col", className)}
    >
      {children}
    </TabsPrimitive>
  )
}

/** The row of tabs: underline tabs on a full width rule. */
export function TabsList({
  className,
  ...props
}: WithClass<ComponentProps<typeof TabsListPrimitive>>) {
  return (
    <TabsListPrimitive
      className={cn(
        "flex w-full items-end gap-5 overflow-x-auto border-b [scrollbar-width:none]",
        className,
      )}
      {...props}
    />
  )
}

/** One tab. Its selected state is a 2px leaf green underline. */
export function TabsTrigger({ className, ...props }: WithClass<ComponentProps<typeof TabsTab>>) {
  return (
    <TabsTab
      className={cn(
        "relative -mb-px inline-flex h-9 shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent text-sm text-muted-foreground outline-offset-[-2px] transition-colors hover:text-foreground data-disabled:opacity-50 data-selected:border-brand data-selected:font-medium data-selected:text-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  )
}

/** The view of one tab. */
export function TabsContent({ className, ...props }: WithClass<ComponentProps<typeof TabsPanel>>) {
  return <TabsPanel className={cn("flex-1 outline-none", className)} {...props} />
}
