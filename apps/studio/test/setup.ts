import { cleanup } from "@testing-library/react"
import { afterEach, expect } from "vitest"
import { unmatchedRequests } from "../mock/admin.ts"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  const unmatched = unmatchedRequests.splice(0)
  expect(unmatched, "Studio called admin endpoints that do not exist").toEqual([])
  cleanup()
  localStorage.clear()
  document.documentElement.className = ""
})
