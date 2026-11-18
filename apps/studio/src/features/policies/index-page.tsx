import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { keys, useApi } from "../../app/context.tsx"
import { EXPOSURE_BADGE, exposureOf } from "../../app/exposure.ts"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatNumber, t } from "../../i18n/index.ts"

/** Lists collections with their published policy version, so an admin can pick one to edit. */
export function PoliciesIndexPage() {
  const api = useApi()
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
  })
  const list = collections.data ?? []
  const guarded = list.filter((collection) => exposureOf(collection) === "guarded").length
  const closed = list.filter((collection) => exposureOf(collection) === "closed").length
  return (
    <>
      <PageHeader
        title={t("policies.title")}
        description={
          collections.data === undefined
            ? t("policies.description")
            : t("policies.index.summary", { guarded, closed, total: list.length })
        }
      />
      {collections.isPending ? (
        <LoadingState />
      ) : collections.isError ? (
        <ErrorState error={collections.error} onRetry={() => void collections.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState>{t("policies.index.empty")}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="w-1/3">
                {t("policies.index.collection")}
              </TableHead>
              <TableHead scope="col">{t("policies.index.access")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("policies.index.policies")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("policies.index.version")}
              </TableHead>
              <TableHead scope="col">{t("policies.index.realtime")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((collection) => {
              const access = exposureOf(collection)
              return (
                <TableRow key={collection.name}>
                  <TableCell>
                    <Link
                      to="/policies/$collection"
                      params={{ collection: collection.name }}
                      aria-label={t("policies.index.open", { name: collection.name })}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {collection.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={EXPOSURE_BADGE[access]}>
                      {t(`overview.collections.accessKinds.${access}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(collection.policyCount ?? 0)}
                  </TableCell>
                  <TableCell className="text-right">
                    {collection.policyVersion === null || collection.policyVersion === undefined ? (
                      <span className="text-muted-foreground">
                        {t("policies.index.unpublished")}
                      </span>
                    ) : (
                      `v${collection.policyVersion}`
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {collection.realtime ? t("common.on") : t("common.off")}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </>
  )
}
