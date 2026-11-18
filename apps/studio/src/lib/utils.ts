import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const merge = extendTailwindMerge({
  extend: { theme: { text: ["title", "kpi"], radius: ["sheet"] } },
})

/** Joins class names and resolves conflicting Tailwind utilities, last one wins. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
