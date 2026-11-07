import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ActivityIcon,
  DatabaseIcon,
  EyeIcon,
  FileClockIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  RadioIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { useApi, useSession } from "../app/context.tsx"
import { setTheme, THEMES, type Theme, useTheme } from "../app/theme.ts"
import { describeViewAs, useViewAs } from "../app/view-as.tsx"
import { type MessageKey, t } from "../i18n/index.ts"
import { cn } from "../lib/utils.ts"
import { Badge } from "./ui/badge.tsx"
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

const NAV: readonly {
  readonly to: string
  readonly label: MessageKey
  readonly icon: ReactNode
  readonly exact?: boolean
}[] = [
  { to: "/", label: "shell.nav.overview", icon: <LayoutDashboardIcon />, exact: true },
  { to: "/data", label: "shell.nav.data", icon: <DatabaseIcon /> },
  { to: "/policies", label: "shell.nav.policies", icon: <ShieldCheckIcon /> },
  { to: "/realtime", label: "shell.nav.realtime", icon: <RadioIcon /> },
  { to: "/auth", label: "shell.nav.auth", icon: <UsersIcon /> },
  { to: "/api", label: "shell.nav.api", icon: <KeyRoundIcon /> },
  { to: "/logs", label: "shell.nav.logs", icon: <FileClockIcon /> },
  { to: "/settings", label: "shell.nav.settings", icon: <SettingsIcon /> },
  { to: "/doctor", label: "shell.nav.doctor", icon: <StethoscopeIcon /> },
]

const THEME_ICONS: Record<Theme, ReactNode> = {
  system: <MonitorIcon aria-hidden="true" />,
  light: <SunIcon aria-hidden="true" />,
  dark: <MoonIcon aria-hidden="true" />,
}

function ThemeMenu() {
  const theme = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t("shell.theme.label")}: ${t(`shell.theme.${theme}`)}`}
        >
          {THEME_ICONS[theme]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("shell.theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
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
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("shell.account")}>
          <UserIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-foreground">
            {t("shell.signedInAs", { email: session.admin.email })}
          </span>
          <span>{t(`common.roles.${session.admin.role}`)}</span>
        </DropdownMenuLabel>
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
      className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm"
    >
      <span className="flex items-center gap-2">
        <EyeIcon className="size-4" aria-hidden="true" />
        <strong>{t("shell.viewAs.banner", { who: describeViewAs(viewAs) })}</strong>
        <span className="text-muted-foreground">
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

/** The authenticated layout: navigation, header and the page. */
export function Shell({ children }: { readonly children: ReactNode }) {
  const session = useSession()
  const environment = session.environment ?? "development"
  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        {t("shell.skipToContent")}
      </a>
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4 font-semibold">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-6" />
          {t("common.appName")}
        </div>
        <nav aria-label={t("shell.mainNavigation")} className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact === true }}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-4",
                "data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground",
              )}
            >
              {item.icon}
              {t(item.label)}
            </Link>
          ))}
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          {session.version === undefined ? null : <span>v{session.version}</span>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-2 border-b px-4">
          <nav
            aria-label={t("shell.mainNavigation")}
            className="flex gap-1 overflow-x-auto md:hidden"
          >
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact === true }}
                aria-label={t(item.label)}
                className="rounded-md p-2 text-muted-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground [&_svg]:size-4"
              >
                {item.icon}
              </Link>
            ))}
          </nav>
          <div className="hidden md:block" />
          <div className="flex items-center gap-1">
            <Badge variant={environment === "production" ? "destructive" : "secondary"}>
              <ActivityIcon aria-hidden="true" />
              {t(`shell.environment.${environment}`)}
            </Badge>
            <ThemeMenu />
            <AccountMenu />
          </div>
        </header>
        <ViewAsBanner />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
