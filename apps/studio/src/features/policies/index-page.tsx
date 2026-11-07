import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { keys, useApi } from "../../app/context.tsx"
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
  return (
    <>
      <PageHeader title={t("policies.title")} description={t("policies.description")} />
      {collections.isPending ? (
        <LoadingState />
      ) : collections.isError ? (
        <ErrorState error={collections.error} onRetry={() => void collections.refetch()} />
      ) : collections.data.length === 0 ? (
        <EmptyState>{t("policies.index.empty")}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("policies.index.collection")}</TableHead>
              <TableHead scope="col">{t("policies.index.policies")}</TableHead>
              <TableHead scope="col">{t("policies.index.version")}</TableHead>
              <TableHead scope="col">{t("policies.index.exposed")}</TableHead>
              <TableHead scope="col">{t("policies.index.realtime")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collections.data.map((collection) => (
              <TableRow key={collection.name}>
                <TableCell>
                  <Link
                    to="/policies/$collection"
                    params={{ collection: collection.name }}
                    aria-label={t("policies.index.open", { name: collection.name })}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {collection.name}
                  </Link>
                </TableCell>
                <TableCell>{formatNumber(collection.policyCount ?? 0)}</TableCell>
                <TableCell>
                  {collection.policyVersion === null || collection.policyVersion === undefined ? (
                    <span className="text-muted-foreground">{t("policies.index.unpublished")}</span>
                  ) : (
                    `v${collection.policyVersion}`
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={collection.exposed ? "success" : "outline"}>
                    {collection.exposed ? t("common.yes") : t("common.no")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={collection.realtime ? "success" : "outline"}>
                    {collection.realtime ? t("common.on") : t("common.off")}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}
