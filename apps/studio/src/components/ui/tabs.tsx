import {
  TabsList as TabsListPrimitive,
  TabsPanel,
  Tabs as TabsPrimitive,
  TabsTab,
} from "@ui-sdk/react/tabs"
import { type ComponentProps, createContext, type ReactNode, useContext } from "react"
import { cn } from "../../lib/utils.ts"

type WithClass<T> = Omit<T, "className"> & { readonly className?: string }

type Variant = "underline" | "segmented"
const VariantContext = createContext<Variant>("underline")

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

/**
 * The row of tabs. `underline` tabs sit on a full width rule and switch the areas of a page; `segmented`
 * tabs are a small track that switches how one block is shown.
 */
export function TabsList({
  className,
  variant = "underline",
  ...props
}: WithClass<ComponentProps<typeof TabsListPrimitive>> & { readonly variant?: Variant }) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsListPrimitive
        className={cn(
          variant === "underline"
            ? "flex w-full items-end gap-5 overflow-x-auto border-b [scrollbar-width:none]"
            : "inline-flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5",
          className,
        )}
        {...props}
      />
    </VariantContext.Provider>
  )
}

/** One tab. Underlined: a 2px leaf green line when selected; segmented: a raised white pill. */
export function TabsTrigger({ className, ...props }: WithClass<ComponentProps<typeof TabsTab>>) {
  const variant = useContext(VariantContext)
  if (variant === "segmented") {
    return (
      <TabsTab
        className={cn(
          "inline-flex h-7 cursor-default items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground data-disabled:opacity-50 data-selected:bg-background data-selected:font-medium data-selected:text-foreground data-selected:shadow-xs [&_svg]:size-3.5",
          className,
        )}
        {...props}
      />
    )
  }
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
