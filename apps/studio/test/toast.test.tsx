import { act, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toaster, useToast } from "../src/components/toast.tsx"

afterEach(() => {
  vi.useRealTimers()
})

function Trigger() {
  const toast = useToast()
  return (
    <button type="button" onClick={() => toast({ title: "Saved" })}>
      save
    </button>
  )
}

describe("Toaster", () => {
  it("dismisses a toast after its delay", () => {
    vi.useFakeTimers()
    const view = render(
      <Toaster>
        <Trigger />
      </Toaster>,
    )
    act(() => view.getByRole("button", { name: "save" }).click())
    expect(view.getByText("Saved")).toBeDefined()
    act(() => vi.advanceTimersByTime(5_000))
    expect(view.queryByText("Saved")).toBeNull()
  })

  it("leaves no timer behind once it unmounts", () => {
    vi.useFakeTimers()
    const view = render(
      <Toaster>
        <Trigger />
      </Toaster>,
    )
    act(() => view.getByRole("button", { name: "save" }).click())
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
