"use client"

import { useCanopy, useCanopyStatus, useQuery } from "@canopy/react"
import { type ReactNode, useMemo } from "react"
import { type Database, LATEST } from "./canopy.ts"

/**
 * The article list. On the first render it shows the documents the Server Component read (hydrated, so
 * `stale` until the socket confirms them), then follows the live query.
 */
export function Articles(): ReactNode {
  const canopy = useCanopy<Database>()
  const query = useMemo(() => canopy.live("articles", LATEST.filter, LATEST.options), [canopy])
  const { data, status } = useQuery(query)
  const connection = useCanopyStatus()
  return (
    <>
      <p role="status" data-query={status} data-connection={connection}>
        {data.length} articles, {status}
      </p>
      <ol>
        {data.map((article) => (
          <li key={String(article._id)}>{article.title}</li>
        ))}
      </ol>
    </>
  )
}
