import { PageHeader } from "../../components/states.tsx"

export function PolicyEditorPage({ collection }: { readonly collection: string }) {
  return <PageHeader title={collection} />
}
