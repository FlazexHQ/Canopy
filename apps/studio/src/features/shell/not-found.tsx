import { Link } from "@tanstack/react-router"
import { EmptyState } from "../../components/states.tsx"
import { Button } from "../../components/ui/button.tsx"
import { t } from "../../i18n/index.ts"

export function NotFound() {
  return (
    <main id="main" className="p-8">
      <EmptyState
        title={t("shell.notFound.title")}
        action={
          <Button asChild variant="outline">
            <Link to="/">{t("shell.notFound.home")}</Link>
          </Button>
        }
      >
        {t("shell.notFound.body")}
      </EmptyState>
    </main>
  )
}
