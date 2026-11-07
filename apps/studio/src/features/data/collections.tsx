import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { DatabaseIcon } from "lucide-react"
import { useState } from "react"
import type { CollectionSummary } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Switch } from "../../components/ui/switch.tsx"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatNumber, t } from "../../i18n/index.ts"

const IMAGE_LABEL = {
  on: "data.collections.imagesOn",
  off: "data.collections.imagesOff",
  unknown: "data.collections.imagesUnknown",
} as const

interface Toggle {
  readonly collection: CollectionSummary
  readonly patch: { readonly exposed?: boolean } | { readonly realtime?: boolean }
}

/** The collections of the app database with their exposure, realtime and policy status. */
export function CollectionsPage() {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
  })
  const update = useMutation({
    mutationFn: async (input: Toggle & { readonly comment?: string }) => {
      await api.updateCollection(input.collection.name, {
        ...input.patch,
        expectedVersion: input.collection.policyVersion ?? 0,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      })
      return input.collection.name
    },
    onSuccess: async (name) => {
      setPending(undefined)
      await queryClient.invalidateQueries({ queryKey: keys.collections })
      await queryClient.invalidateQueries({ queryKey: keys.policies(name) })
      toast({ title: t("data.collections.updated", { name }), variant: "success" })
    },
    onError: (error) =>
      toast({ title: t("data.write.failed"), description: errorMessage(error), variant: "error" }),
  })
  const [pending, setPending] = useState<Toggle | undefined>(undefined)
  const canToggle = permissions.toggleCollections
  const toggle = (next: Toggle) => {
    if (permissions.publishNeedsComment) setPending(next)
    else update.mutate(next)
  }

  return (
    <div>
      <PageHeader title={t("data.title")} description={t("data.description")} />
      {collections.isPending ? (
        <LoadingState rows={4} />
      ) : collections.isError ? (
        <ErrorState error={collections.error} onRetry={() => void collections.refetch()} />
      ) : collections.data.length === 0 ? (
        <EmptyState icon={<DatabaseIcon />}>{t("data.collections.empty")}</EmptyState>
      ) : (
        <Table>
          <TableCaption>{t("data.collections.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("data.collections.name")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("data.collections.count")}
              </TableHead>
              <TableHead scope="col">{t("data.collections.exposed")}</TableHead>
              <TableHead scope="col">{t("data.collections.realtime")}</TableHead>
              <TableHead scope="col">{t("data.collections.policies")}</TableHead>
              <TableHead scope="col">{t("data.collections.images")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collections.data.map((collection) => (
              <TableRow key={collection.name}>
                <TableCell>
                  <Link
                    to="/data/$collection"
                    params={{ collection: collection.name }}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                    aria-label={t("data.collections.browse", { name: collection.name })}
                  >
                    {collection.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {collection.estimatedCount === undefined
                    ? t("common.unknown")
                    : formatNumber(collection.estimatedCount)}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={collection.exposed}
                    disabled={!canToggle || update.isPending}
                    aria-label={t("data.collections.toggleExposed", { name: collection.name })}
                    onCheckedChange={(exposed) => toggle({ collection, patch: { exposed } })}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={collection.realtime}
                    disabled={!canToggle || update.isPending}
                    aria-label={t("data.collections.toggleRealtime", { name: collection.name })}
                    onCheckedChange={(realtime) => toggle({ collection, patch: { realtime } })}
                  />
                </TableCell>
                <TableCell>
                  <Link to="/policies/$collection" params={{ collection: collection.name }}>
                    <span className="sr-only">
                      {t("data.collections.editPolicies", { name: collection.name })}:{" "}
                    </span>
                    {collection.policyVersion === undefined || collection.policyVersion === null ? (
                      <Badge variant="warning">{t("data.collections.noPolicy")}</Badge>
                    ) : (
                      <Badge variant="secondary">
                        {t("data.collections.policyVersion", {
                          version: collection.policyVersion,
                          count: collection.policyCount ?? 0,
                        })}
                      </Badge>
                    )}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant={collection.images === "on" ? "success" : "outline"}>
                    {t(IMAGE_LABEL[collection.images ?? "unknown"])}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined)
        }}
        title={t("data.collections.toggleTitle", { name: pending?.collection.name ?? "" })}
        description={t("data.collections.toggleDescription")}
        confirmLabel={t("data.collections.toggleConfirm")}
        reason={{ label: t("data.collections.comment"), required: true }}
        pending={update.isPending}
        onConfirm={({ reason }) => {
          if (pending !== undefined) update.mutate({ ...pending, comment: reason })
        }}
      />
    </div>
  )
}
