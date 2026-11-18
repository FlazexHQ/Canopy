import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from "@ui-sdk/react/command"
import {
  DialogBackdrop,
  DialogContent,
  Dialog as DialogPrimitive,
  DialogShortcut,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog"
import { DatabaseIcon, SearchIcon, ShieldCheckIcon } from "lucide-react"
import { type ReactNode, useState } from "react"
import { keys, useApi } from "../app/context.tsx"
import { type MessageKey, t } from "../i18n/index.ts"

/** A destination in the main navigation. */
export interface Destination {
  readonly to: string
  readonly label: MessageKey
  readonly icon: ReactNode
}

const itemClass =
  "flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-highlighted:bg-active [&_svg]:size-4 [&_svg]:text-muted-foreground"

/** The command palette that jumps to a page, a collection's documents or its policies (Ctrl or Cmd + K). */
export function JumpTo({ destinations }: { readonly destinations: readonly Destination[] }) {
  const api = useApi()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
    enabled: open,
  })
  const go = (value: string) => {
    setOpen(false)
    const [kind, name] = value.split(":", 2)
    if (kind === "page" && name !== undefined) void navigate({ to: name })
    if (kind === "data" && name !== undefined)
      void navigate({ to: "/data/$collection", params: { collection: name } })
    if (kind === "policies" && name !== undefined)
      void navigate({ to: "/policies/$collection", params: { collection: name } })
  }
  return (
    <DialogPrimitive open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogTrigger
        shortcut="mod+k"
        className="flex h-8 w-full max-w-[34rem] items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:border-input hover:text-foreground"
      >
        <SearchIcon className="size-4" aria-hidden="true" />
        <span className="flex-1 truncate text-left">{t("shell.jump.open")}</span>
        <DialogShortcut className="rounded border border-border px-1.5 font-mono text-[11px] leading-5" />
      </DialogTrigger>
      <DialogBackdrop className="backdrop-motion modal-exit fixed inset-0 bg-black/30 dark:bg-black/60" />
      <DialogContent className="popup-motion modal-exit fixed inset-x-0 top-[12vh] mx-auto w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none">
        <DialogTitle className="sr-only">{t("shell.jump.label")}</DialogTitle>
        <Command onAction={go} autoHighlight>
          <div className="flex items-center gap-2 border-b px-3">
            <SearchIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <CommandInput
              aria-label={t("shell.jump.label")}
              placeholder={t("shell.jump.placeholder")}
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandEmpty className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t("shell.jump.empty")}
          </CommandEmpty>
          <CommandList className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
            <CommandGroup>
              <CommandGroupLabel className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
                {t("shell.jump.pages")}
              </CommandGroupLabel>
              {destinations.map((item) => (
                <CommandItem key={item.to} value={`page:${item.to}`} className={itemClass}>
                  <CommandItemIcon>{item.icon}</CommandItemIcon>
                  {t(item.label)}
                </CommandItem>
              ))}
            </CommandGroup>
            {(collections.data ?? []).length === 0 ? null : (
              <CommandGroup>
                <CommandGroupLabel className="px-2.5 pt-2.5 pb-1 text-xs text-muted-foreground">
                  {t("shell.jump.collections")}
                </CommandGroupLabel>
                {(collections.data ?? []).flatMap((collection) => [
                  <CommandItem
                    key={`data:${collection.name}`}
                    value={`data:${collection.name}`}
                    keywords={[collection.name]}
                    className={itemClass}
                  >
                    <CommandItemIcon>
                      <DatabaseIcon />
                    </CommandItemIcon>
                    {t("shell.jump.collectionData", { name: collection.name })}
                  </CommandItem>,
                  <CommandItem
                    key={`policies:${collection.name}`}
                    value={`policies:${collection.name}`}
                    keywords={[collection.name]}
                    className={itemClass}
                  >
                    <CommandItemIcon>
                      <ShieldCheckIcon />
                    </CommandItemIcon>
                    {t("shell.jump.collectionPolicies", { name: collection.name })}
                  </CommandItem>,
                ])}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </DialogPrimitive>
  )
}
