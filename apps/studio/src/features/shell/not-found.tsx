import { Link } from "@tanstack/react-router"
import { EmptyState } from "../../components/states.tsx"
import { buttonVariants } from "../../components/ui/button.tsx"
import { t } from "../../i18n/index.ts"

export function NotFound() {
  return (
    <main id="main" className="p-8">
      <EmptyState
        title={t("shell.notFound.title")}
        action={
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            {t("shell.notFound.home")}
          </Link>
        }
      >
        {t("shell.notFound.body")}
      </EmptyState>
    </main>
  )
}
