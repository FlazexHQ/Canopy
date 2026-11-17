import type { ReactNode } from "react"
import { Providers } from "./providers.tsx"

export const metadata = { title: "Canopy on Next.js" }

/** The root layout: every page renders inside the Canopy provider. */
export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
