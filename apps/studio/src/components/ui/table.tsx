import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

/** A data table: rules and alignment, no zebra and no header band. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm tabular-nums", className)} {...props} />
    </div>
  )
}

/** The header rows of a {@link Table}. */
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />
}

/** The body rows of a {@link Table}. */
export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
}

/** One row of a {@link Table}. */
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-rule transition-colors hover:bg-raised/70 data-[state=selected]:bg-active",
        className,
      )}
      {...props}
    />
  )
}

/** A column header: small grey sentence case. */
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-9 whitespace-nowrap px-3 text-left align-middle text-xs font-normal text-muted-foreground first:pl-0 last:pr-0",
        className,
      )}
      {...props}
    />
  )
}

/** One cell of a {@link Table}. */
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td className={cn("px-3 py-2.5 align-middle first:pl-0 last:pr-0", className)} {...props} />
  )
}

/** A caption under a {@link Table}. */
export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
}
