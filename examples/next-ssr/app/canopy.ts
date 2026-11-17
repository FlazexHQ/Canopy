import type { DocumentSchema, LiveQueryOptions, ObjectId } from "@canopy/client"

/** An article as MongoDB stores it. */
export interface Article {
  readonly _id: ObjectId | string
  title: string
  published: boolean
  publishedAt: Date
}

/** The collections the app reads. */
export type Database = DocumentSchema<{ articles: Article }>

/** Where Canopy runs and the key the browser and the server send. */
export const CANOPY_URL = process.env["NEXT_PUBLIC_CANOPY_URL"] ?? "http://localhost:8090"
export const CANOPY_KEY = process.env["NEXT_PUBLIC_CANOPY_KEY"] ?? "pk_next_local"

/**
 * The one query of the page. The Server Component reads it and the browser follows it live with the same
 * filter and options, which is what lets the server's result seed the live query.
 */
export const LATEST = {
  filter: {},
  options: { sort: { publishedAt: -1 }, limit: 20 } satisfies LiveQueryOptions<Article>,
} as const
