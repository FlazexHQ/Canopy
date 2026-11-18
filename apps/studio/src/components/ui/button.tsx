import { Button as ButtonPrimitive } from "@ui-sdk/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** The classes of a button, for links and triggers that look like one. */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,border-color,scale] duration-100 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 aria-disabled:pointer-events-none aria-disabled:opacity-60 data-pending:cursor-progress [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background text-foreground hover:border-foreground/30 hover:bg-raised",
        secondary: "bg-secondary text-secondary-foreground hover:bg-active",
        ghost: "text-foreground hover:bg-accent",
        link: "h-auto px-0 text-brand underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[13px]",
        lg: "h-9 px-4",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

/** Props of {@link Button}. */
export type ButtonProps = Omit<ComponentProps<typeof ButtonPrimitive>, "className"> &
  VariantProps<typeof buttonVariants> & { readonly className?: string }

/** A button. Pass `render` to draw it as another element, such as a router link. */
export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
