import {
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  Menu as MenuPrimitive,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/utils.ts"

type WithClass<T> = Omit<T, "className" | "children"> & {
  readonly className?: string
  readonly children?: ReactNode
}

/** A menu of actions opened from a trigger. */
export const DropdownMenu = MenuPrimitive

/** The button that opens a {@link DropdownMenu}. */
export function DropdownMenuTrigger(props: WithClass<ComponentProps<typeof MenuTrigger>>) {
  return <MenuTrigger {...props} />
}

/** A radio group of menu items, such as the theme. */
export function DropdownMenuRadioGroup<T extends string>({
  value,
  onValueChange,
  children,
}: {
  readonly value: T
  readonly onValueChange: (value: T) => void
  readonly children: ComponentProps<typeof MenuRadioGroup>["children"]
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next: unknown) => {
        if (typeof next === "string") onValueChange(next as T)
      }}
    >
      {children}
    </MenuRadioGroup>
  )
}

/** The popup list of a {@link DropdownMenu}. */
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: WithClass<ComponentProps<typeof MenuContent>>) {
  return (
    <MenuContent
      sideOffset={sideOffset}
      className={cn(
        "popup-motion min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
        className,
      )}
      {...props}
    />
  )
}

const itemClass =
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 data-destructive:text-destructive [&_svg]:size-4 [&_svg]:text-muted-foreground"

/** One action in a {@link DropdownMenu}. */
export function DropdownMenuItem({
  className,
  variant,
  ...props
}: WithClass<ComponentProps<typeof MenuItem>> & { readonly variant?: "destructive" }) {
  return (
    <MenuItem
      destructive={variant === "destructive"}
      className={cn(itemClass, className)}
      {...props}
    />
  )
}

/** One choice in a {@link DropdownMenuRadioGroup}. */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: WithClass<ComponentProps<typeof MenuRadioItem>>) {
  return (
    <MenuRadioItem className={cn(itemClass, "pl-7", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <MenuItemIndicator>
          <span className="block size-1.5 rounded-full bg-current" />
        </MenuItemIndicator>
      </span>
      {children}
    </MenuRadioItem>
  )
}

/** A quiet heading inside a menu. */
export function DropdownMenuLabel({
  className,
  ...props
}: WithClass<ComponentProps<typeof MenuGroupLabel>>) {
  return (
    <MenuGroupLabel
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

/** A gap between groups of menu items. */
export function DropdownMenuSeparator({
  className,
  ...props
}: WithClass<ComponentProps<typeof MenuSeparator>>) {
  return <MenuSeparator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}
