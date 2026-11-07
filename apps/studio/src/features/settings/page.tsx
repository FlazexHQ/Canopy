import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { XIcon } from "lucide-react"
import { useEffect, useId, useState } from "react"
import type { Settings } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { t } from "../../i18n/index.ts"

/** Whether a value is a browser origin: a scheme and host with an optional port, no path. */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
  } catch {
    return false
  }
}

function GeneralCard({
  settings,
  editable,
}: {
  readonly settings: Settings
  readonly editable: boolean
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const urlId = useId()
  const originId = useId()
  const originError = useId()
  const [publicUrl, setPublicUrl] = useState(settings.publicUrl ?? "")
  const [origins, setOrigins] = useState<readonly string[]>(settings.corsOrigins)
  const [limits, setLimits] = useState<Record<string, number>>(settings.limits ?? {})
  const [candidate, setCandidate] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  useEffect(() => {
    setPublicUrl(settings.publicUrl ?? "")
    setOrigins(settings.corsOrigins)
    setLimits(settings.limits ?? {})
  }, [settings])
  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        publicUrl: publicUrl.trim() === "" ? null : publicUrl.trim(),
        corsOrigins: [...origins],
        limits,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.settings, next)
      toast({ title: t("settings.saved"), variant: "success" })
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  const add = () => {
    const origin = candidate.trim().replace(/\/+$/, "")
    if (!isOrigin(origin)) {
      setProblem(t("settings.corsInvalid", { origin }))
      return
    }
    if (origins.includes(origin)) {
      setProblem(t("settings.corsDuplicate", { origin }))
      return
    }
    setOrigins([...origins, origin])
    setCandidate("")
    setProblem(undefined)
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.general")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <div className="grid max-w-lg gap-2">
            <Label htmlFor={urlId}>{t("settings.publicUrl")}</Label>
            <Input
              id={urlId}
              type="url"
              value={publicUrl}
              disabled={!editable}
              aria-describedby={`${urlId}-hint`}
              onChange={(event) => setPublicUrl(event.target.value)}
            />
            <p id={`${urlId}-hint`} className="text-xs text-muted-foreground">
              {t("settings.publicUrlHint")}
            </p>
          </div>
          <fieldset className="grid max-w-lg gap-2">
            <legend className="text-sm font-medium">{t("settings.cors")}</legend>
            <p className="text-xs text-muted-foreground">{t("settings.corsHint")}</p>
            {origins.length === 0 ? (
              <p className="text-sm text-warning">{t("settings.corsEmpty")}</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label={t("settings.cors")}>
                {origins.map((origin) => (
                  <li key={origin}>
                    <Badge variant="outline" className="gap-1 py-1 font-mono">
                      {origin}
                      {editable ? (
                        <button
                          type="button"
                          className="rounded-sm opacity-70 hover:opacity-100"
                          aria-label={t("settings.corsRemove", { origin })}
                          onClick={() => setOrigins(origins.filter((entry) => entry !== origin))}
                        >
                          <XIcon aria-hidden="true" />
                        </button>
                      ) : null}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {editable ? (
              <div className="grid gap-2">
                <Label htmlFor={originId}>{t("settings.corsLabel")}</Label>
                <div className="flex gap-2">
                  <Input
                    id={originId}
                    value={candidate}
                    placeholder={t("settings.corsPlaceholder")}
                    aria-invalid={problem !== undefined}
                    aria-describedby={problem === undefined ? undefined : originError}
                    onChange={(event) => setCandidate(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        add()
                      }
                    }}
                  />
                  <Button variant="outline" onClick={add}>
                    {t("settings.corsAdd")}
                  </Button>
                </div>
                {problem === undefined ? null : (
                  <p id={originError} role="alert" className="text-sm text-destructive">
                    {problem}
                  </p>
                )}
              </div>
            ) : null}
          </fieldset>
          {Object.keys(limits).length === 0 ? null : (
            <fieldset className="grid max-w-lg gap-3">
              <legend className="text-sm font-medium">{t("settings.limits")}</legend>
              {Object.entries(limits).map(([name, value]) => (
                <div key={name} className="grid grid-cols-[1fr_10rem] items-center gap-2">
                  <Label htmlFor={`limit-${name}`} className="font-mono text-xs">
                    {name}
                  </Label>
                  <Input
                    id={`limit-${name}`}
                    type="number"
                    min={0}
                    value={value}
                    disabled={!editable}
                    onChange={(event) =>
                      setLimits({ ...limits, [name]: Number(event.target.value) })
                    }
                  />
                </div>
              ))}
            </fieldset>
          )}
          {editable ? (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

function RealtimeCard({ settings }: { readonly settings: Settings }) {
  const collections = settings.realtime?.collections ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.realtime")}</CardTitle>
        <CardDescription>
          {t("settings.realtimeMode")}: {settings.realtime?.mode ?? t("common.unknown")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.noRealtime")}</p>
        ) : (
          <Table aria-label={t("settings.images")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.collection")}</TableHead>
                <TableHead>{t("settings.images")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collections.map((collection) => (
                <TableRow key={collection.name}>
                  <TableCell className="font-medium">{collection.name}</TableCell>
                  <TableCell>
                    <Badge variant={collection.images === "on" ? "success" : "secondary"}>
                      {collection.images === "on"
                        ? t("settings.imagesOn")
                        : collection.images === "off"
                          ? t("settings.imagesOff")
                          : t("settings.imagesUnknown")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">{t("settings.imagesHint")}</p>
      </CardContent>
    </Card>
  )
}

function AdminsCard({ settings }: { readonly settings: Settings }) {
  const admins = settings.admins ?? []
  if (admins.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.admins")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label={t("settings.admins")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("settings.email")}</TableHead>
              <TableHead>{t("settings.role")}</TableHead>
              <TableHead>{t("settings.totp")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map((admin) => (
              <TableRow key={admin.id}>
                <TableCell>{admin.email}</TableCell>
                <TableCell>{t(`common.roles.${admin.role}`)}</TableCell>
                <TableCell>
                  {admin.totp === true ? t("settings.totpOn") : t("settings.totpOff")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

type DangerAction = "revokeSessions" | "rotateMasterKey"

function DangerZone() {
  const api = useApi()
  const toast = useToast()
  const [action, setAction] = useState<DangerAction | undefined>(undefined)
  const run = useMutation({
    mutationFn: ({ which, typed }: { which: DangerAction; typed: string }) =>
      which === "revokeSessions" ? api.revokeAllSessions(typed) : api.rotateMasterKey(typed),
    onSuccess: (_, { which }) => {
      setAction(undefined)
      toast({
        title:
          which === "revokeSessions"
            ? t("settings.danger.revokeSessionsDone")
            : t("settings.danger.rotateMasterKeyDone"),
        variant: "success",
      })
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  const phrase =
    action === "rotateMasterKey"
      ? t("settings.danger.rotateMasterKeyPhrase")
      : t("settings.danger.revokeSessionsPhrase")
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>{t("settings.danger.title")}</CardTitle>
        <CardDescription>{t("settings.danger.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {(["revokeSessions", "rotateMasterKey"] as const).map((which) => (
          <div key={which} className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-prose text-sm text-muted-foreground">
              {t(`settings.danger.${which}Body`)}
            </p>
            <Button variant="destructive" onClick={() => setAction(which)}>
              {t(`settings.danger.${which}`)}
            </Button>
          </div>
        ))}
      </CardContent>
      <ConfirmDialog
        open={action !== undefined}
        onOpenChange={(open) => (open ? undefined : setAction(undefined))}
        title={action === undefined ? "" : t(`settings.danger.${action}`)}
        description={action === undefined ? undefined : t(`settings.danger.${action}Body`)}
        confirmLabel={action === undefined ? t("common.confirm") : t(`settings.danger.${action}`)}
        destructive
        typedConfirmation={phrase}
        pending={run.isPending}
        onConfirm={({ typed }) => {
          if (action !== undefined) run.mutate({ which: action, typed })
        }}
      />
    </Card>
  )
}

export function SettingsPage() {
  const api = useApi()
  const { permissions } = useSession()
  const query = useQuery({ queryKey: keys.settings, queryFn: ({ signal }) => api.settings(signal) })
  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="grid max-w-4xl gap-6">
          {permissions.manageSettings ? null : (
            <p className="text-sm text-muted-foreground">{t("settings.readOnly")}</p>
          )}
          <GeneralCard settings={query.data} editable={permissions.manageSettings} />
          <RealtimeCard settings={query.data} />
          <AdminsCard settings={query.data} />
          {permissions.dangerZone ? <DangerZone /> : null}
        </div>
      )}
    </>
  )
}
