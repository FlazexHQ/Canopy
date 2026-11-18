import { cn } from "../lib/utils.ts"

/** The Canopy mark: a layered crown over a trunk, drawn in the brand colour. */
export function CanopyMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-6 text-brand", className)}>
      <path d="M2.5 14.5a9.5 9.5 0 0 1 19 0Z" fill="currentColor" />
      <path
        d="M7 14.5a5 5 0 0 1 10 0"
        fill="none"
        stroke="var(--frame)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect x="11" y="14.5" width="2" height="7" rx="1" fill="currentColor" />
    </svg>
  )
}
