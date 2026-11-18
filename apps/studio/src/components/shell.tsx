import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  DialogBackdrop,
  DialogClose,
  DialogContent,
  Dialog as DialogPrimitive,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog"
import {
  DatabaseIcon,
  EyeIcon,
  FileClockIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  RadioIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  SunIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { useApi, useSession } from "../app/context.tsx"
import { setTheme, THEMES, type Theme, useTheme } from "../app/theme.ts"
import { describeViewAs, useViewAs } from "../app/view-as.tsx"
import { type MessageKey, t } from "../i18n/index.ts"
import { cn } from "../lib/utils.ts"
import { type Destination, JumpTo } from "./jump.tsx"
import { CanopyMark } from "./mark.tsx"
import { Button } from "./ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"

interface NavItem extends Destination {
  readonly exact?: boolean
}

const NAV: readonly { readonly group?: MessageKey; readonly items: readonly NavItem[] }[] = [
  {
    items: [{ to: "/", label: "shell.nav.overview", icon: <LayoutDashboardIcon />, exact: true }],
  },
  {
    group: "shell.groups.build",
    items: [
      { to: "/data", label: "shell.nav.data", icon: <DatabaseIcon /> },
      { to: "/policies", label: "shell.nav.policies", icon: <ShieldCheckIcon /> },
      { to: "/realtime", label: "shell.nav.realtime", icon: <RadioIcon /> },
      { to: "/auth", label: "shell.nav.auth", icon: <UsersIcon /> },
      { to: "/api", label: "shell.nav.api", icon: <KeyRoundIcon /> },
    ],
  },
  {
    group: "shell.groups.operate",
    items: [
      { to: "/logs", label: "shell.nav.logs", icon: <FileClockIcon /> },
      { to: "/settings", label: "shell.nav.settings", icon: <SettingsIcon /> },
      { to: "/doctor", label: "shell.nav.doctor", icon: <StethoscopeIcon /> },
    ],
  },
]

const DESTINATIONS: readonly Destination[] = NAV.flatMap((section) => section.items)

const THEME_ICONS: Record<Theme, ReactNode> = {
  system: <MonitorIcon aria-hidden="true" />,
  light: <SunIcon aria-hidden="true" />,
  dark: <MoonIcon aria-hidden="true" />,
}

function Navigation({ onNavigate }: { readonly onNavigate?: () => void }) {
  return (
    <nav aria-label={t("shell.mainNavigation")} className="flex flex-col gap-5 px-3">
      {NAV.map((section) => (
        <div key={section.group ?? "home"} className="flex flex-col gap-0.5">
          {section.group === undefined ? null : (
            <p className="px-2.5 pb-1 text-xs text-muted-foreground">{t(section.group)}</p>
          )}
          {section.items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact === true }}
              {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-active/60 hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
                "data-[status=active]:bg-active data-[status=active]:font-medium data-[status=active]:text-foreground",
              )}
            >
              {item.icon}
              {t(item.label)}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}

function Brand() {
  return (
    <Link
      to="/"
      className="flex h-12 items-center gap-2.5 rounded-md px-2.5 text-[15px] font-semibold"
    >
      <CanopyMark />
      {t("common.appName")}
    </Link>
  )
}

function ScopeLine() {
  const session = useSession()
  const environment = session.environment ?? "development"
  return (
    <div className="flex items-center gap-2 px-5 pb-4 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          environment === "production" ? "bg-destructive" : "bg-success",
        )}
      />
      <span>{t(`shell.environment.${environment}`)}</span>
      {session.version === undefined ? null : <span className="ml-auto">v{session.version}</span>}
    </div>
  )
}

function MobileNavigation() {
  const [open, setOpen] = useState(false)
  const path = useRouterState({ select: (state) => state.location.pathname })
  useEffect(() => {
    if (path !== "") setOpen(false)
  }, [path])
  return (
    <DialogPrimitive open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogTrigger
        aria-label={t("shell.openNavigation")}
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-active md:hidden [&_svg]:size-4"
      >
        <MenuIcon aria-hidden="true" />
      </DialogTrigger>
      <DialogBackdrop className="backdrop-motion fixed inset-0 bg-black/30" />
      <DialogContent className="fixed inset-y-0 left-0 m-0 flex h-dvh max-h-none w-72 max-w-[85vw] flex-col gap-2 bg-frame pb-4 transition-transform duration-200 outline-none data-starting-style:-translate-x-full data-ending-style:-translate-x-full">
        <div className="flex items-center justify-between pr-3 pl-0.5">
          <DialogTitle className="sr-only">{t("shell.mainNavigation")}</DialogTitle>
          <Brand />
          <DialogClose
            aria-label={t("common.close")}
            className="inline-flex size-8 items-center justify-center rounded-md hover:bg-active [&_svg]:size-4"
          >
            <XIcon aria-hidden="true" />
          </DialogClose>
        </div>
        <ScopeLine />
        <Navigation onNavigate={() => setOpen(false)} />
      </DialogContent>
    </DialogPrimitive>
  )
}

function ThemeMenu() {
  const theme = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${t("shell.theme.label")}: ${t(`shell.theme.${theme}`)}`}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-active hover:text-foreground [&_svg]:size-4"
      >
        {THEME_ICONS[theme]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("shell.theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup<Theme> value={theme} onValueChange={setTheme}>
          {THEMES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {t(`shell.theme.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function initials(email: string): string {
  const name = email.split("@")[0] ?? email
  const parts = name.split(/[._-]+/).filter((part) => part !== "")
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2)
  return letters.toUpperCase()
}

function AccountMenu() {
  const api = useApi()
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: async () => {
      queryClient.clear()
      await navigate({ to: "/login" })
    },
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("shell.account")}
        className="inline-flex size-8 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand transition-[box-shadow] hover:ring-2 hover:ring-active"
      >
        <span aria-hidden="true">{initials(session.admin.email)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm">
            {t("shell.signedInAs", { email: session.admin.email })}
          </p>
          <p className="text-xs text-muted-foreground">{t(`common.roles.${session.admin.role}`)}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout.mutate()}>
          <LogOutIcon aria-hidden="true" />
          {t("shell.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ViewAsBanner() {
  const { viewAs, writeReason, stop } = useViewAs()
  if (viewAs === undefined) return null
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-t-[15px] bg-pill-warning px-4 py-2 text-sm text-pill-warning-ink md:px-8"
    >
      <span className="flex flex-wrap items-center gap-x-2">
        <EyeIcon className="size-4" aria-hidden="true" />
        <strong className="font-medium">
          {t("shell.viewAs.banner", { who: describeViewAs(viewAs) })}
        </strong>
        <span className="opacity-80">
          {writeReason === undefined
            ? t("shell.viewAs.readOnly")
            : t("shell.viewAs.writesUnlocked", { reason: writeReason })}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={stop}>
        {t("shell.viewAs.stop")}
      </Button>
    </div>
  )
}

/**
 * The authenticated layout. The sidebar and the top bar share one tinted frame with no rule between them;
 * the page sits on a white sheet inset from the window's right and bottom edges.
 */
export function Shell({ children }: { readonly children: ReactNode }) {
  const session = useSession()
  const production = session.environment === "production"
  return (
    <div className="flex min-h-dvh bg-frame">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        {t("shell.skipToContent")}
      </a>
      <aside className="sticky top-0 hidden h-dvh w-[228px] shrink-0 flex-col md:flex">
        <div className="px-2.5">
          <Brand />
        </div>
        <ScopeLine />
        <div className="flex-1 overflow-y-auto pb-4">
          <Navigation />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3 md:pr-2 md:pl-0">
          <MobileNavigation />
          <div className="flex min-w-0 flex-1 justify-center">
            <JumpTo destinations={DESTINATIONS} />
          </div>
          <div className="flex items-center gap-1">
            <ThemeMenu />
            <AccountMenu />
          </div>
        </header>
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col border-t bg-background md:mr-2 md:mb-2 md:rounded-[16px] md:border",
            production && "border-t-2 border-t-destructive md:border-t-2 md:border-t-destructive",
          )}
        >
          <ViewAsBanner />
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-[1320px] min-w-0 flex-1 px-4 py-5 outline-none md:px-8 md:py-7"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
