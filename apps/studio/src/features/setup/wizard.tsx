import { PageHeader } from "../../components/states.tsx"
import { t } from "../../i18n/index.ts"

export function SetupWizard() {
  return <PageHeader title={t("common.appName")} />
}
