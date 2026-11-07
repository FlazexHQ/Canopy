import { useSyncExternalStore } from "react"

export const THEMES = ["system", "light", "dark"] as const
export type Theme = (typeof THEMES)[number]

const STORAGE_KEY = "canopy-studio-theme"
const listeners = new Set<() => void>()

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
}

/** Applies the stored theme to `<html>` and follows the system setting while on `system`. */
export function applyTheme(theme: Theme = stored()): void {
  const dark = theme === "dark" || (theme === "system" && systemDark())
  document.documentElement.classList.toggle("dark", dark)
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this page only.
  }
  current = theme
  applyTheme(theme)
  for (const listener of listeners) listener()
}

let current: Theme = typeof localStorage === "undefined" ? "system" : stored()

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => "system",
  )
}

/** Keeps the page in sync with the system color scheme while the theme is `system`. */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia !== "function") return () => {}
  const query = matchMedia("(prefers-color-scheme: dark)")
  const onChange = () => {
    if (current === "system") applyTheme("system")
  }
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
