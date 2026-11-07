import { PageHeader } from "../../components/states.tsx"
import { t } from "../../i18n/index.ts"

export function AuthPage() {
  return <PageHeader title={t("shell.nav.auth")} />
}
