import {
  DialogBackdrop,
  DialogClose,
  DialogContent as DialogContentPrimitive,
  DialogDescription as DialogDescriptionPrimitive,
  Dialog as DialogPrimitive,
  DialogTitle as DialogTitlePrimitive,
} from "@ui-sdk/react/dialog"
import { XIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { t } from "../../i18n/index.ts"
import { cn } from "../../lib/utils.ts"

type WithClass<T> = Omit<T, "className" | "children"> & {
  readonly className?: string
  readonly children?: ReactNode
}

/** A modal dialog, always controlled by its parent. */
export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly children: ReactNode
}) {
  return (
    <DialogPrimitive open={open} onOpenChange={(next) => onOpenChange(next)}>
      {children}
    </DialogPrimitive>
  )
}

/** The panel of a {@link Dialog}, with its backdrop and a close button. */
export function DialogContent({
  className,
  children,
  ...props
}: WithClass<ComponentProps<typeof DialogContentPrimitive>>) {
  return (
    <>
      <DialogBackdrop className="backdrop-motion modal-exit fixed inset-0 bg-black/40 dark:bg-black/60" />
      <DialogContentPrimitive
        className={cn(
          "popup-motion modal-exit fixed inset-0 m-auto grid h-fit max-h-[min(90vh,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-lg gap-4 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
        <DialogClose
          aria-label={t("common.close")}
          className="absolute top-4 right-4 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
        >
          <XIcon aria-hidden="true" />
        </DialogClose>
      </DialogContentPrimitive>
    </>
  )
}

/** The title and description block at the top of a dialog. */
export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-8 text-left", className)} {...props} />
}

/** The actions at the foot of a dialog, the primary one last. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

/** Names the dialog. */
export function DialogTitle({
  className,
  ...props
}: WithClass<ComponentProps<typeof DialogTitlePrimitive>>) {
  return (
    <DialogTitlePrimitive
      className={cn("text-base font-semibold leading-6", className)}
      {...props}
    />
  )
}

/** Explains the dialog under its title. */
export function DialogDescription({
  className,
  ...props
}: WithClass<ComponentProps<typeof DialogDescriptionPrimitive>>) {
  return (
    <DialogDescriptionPrimitive
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}
