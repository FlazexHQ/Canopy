import { PageHeader } from "../../components/states.tsx"

export function DocumentsPage({ collection }: { readonly collection: string }) {
  return <PageHeader title={collection} />
}
