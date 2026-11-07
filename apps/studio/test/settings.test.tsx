import { addressAllowed, isAddressRule } from "@canopy/auth/address"
import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  isOrigin,
  logRetentionOf,
  retentionOf,
  sampleRateOf,
} from "../src/features/settings/page.tsx"
import { adminOf, renderStudio, screen } from "./harness.tsx"

const lastDialog = () => {
  const dialog = screen.getAllByRole("dialog").at(-1)
  if (dialog === undefined) throw new Error("no dialog open")
  return within(dialog)
}

describe("Settings", () => {
  it("saves the audit retention", async () => {
    const { user, mock } = await renderStudio("/settings")
    const field = await screen.findByLabelText("Keep audit entries for (days)")
    await user.type(field, "90")
    await user.click(
      within(field.closest("form") as HTMLElement).getByRole("button", { name: "Save" }),
    )
    await waitFor(() => expect(mock.state.settings.auditRetentionDays).toBe(90))
  })

  it("saves the request log sample rate as a share and the retention in days", async () => {
    const { user, mock } = await renderStudio("/settings")
    const rate = await screen.findByLabelText("Sample rate (percent of requests)")
    expect((rate as HTMLInputElement).value).toBe("1")
    const days = screen.getByLabelText("Keep request log entries for (days)")
    expect((days as HTMLInputElement).value).toBe("7")
    await user.clear(rate)
    await user.type(rate, "150")
    const form = rate.closest("form") as HTMLElement
    await user.click(within(form).getByRole("button", { name: "Save" }))
    expect(await screen.findByText("Enter a percentage from 0 to 100.")).toBeTruthy()
    expect(mock.state.settings.requestLogSampleRate).toBe(0.01)
    await user.clear(rate)
    await user.type(rate, "12.5")
    await user.clear(days)
    await user.type(days, "30")
    await user.click(within(form).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mock.state.settings.requestLogSampleRate).toBe(0.125))
    expect(mock.state.settings.requestLogRetentionDays).toBe(30)
    expect(mock.state.audit[0]).toMatchObject({ action: "settings.update" })
  })

  it("validates allowlist entries and refuses a list that would lock the admin out", async () => {
    const { user, mock } = await renderStudio("/settings", { clientIp: "203.0.113.7" })
    const field = await screen.findByLabelText("Address or CIDR range")
    await user.type(field, "10.0.0.300")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("10.0.0.300 is not an IP address or CIDR range.")).toBeTruthy()
    await user.clear(field)
    await user.type(field, "10.0.0.0/8")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("10.0.0.0/8")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Save allowlist" }))
    expect(
      await screen.findByText(/does not include the address you are connected from/),
    ).toBeTruthy()
    expect(mock.state.settings.adminAllowlist).toEqual([])
    await user.type(field, "203.0.113.0/24")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(screen.getByRole("button", { name: "Save allowlist" }))
    await waitFor(() =>
      expect(mock.state.settings.adminAllowlist).toEqual(["10.0.0.0/8", "203.0.113.0/24"]),
    )
    await user.click(screen.getByRole("button", { name: "Remove 10.0.0.0/8" }))
    await user.click(screen.getByRole("button", { name: "Save allowlist" }))
    await waitFor(() => expect(mock.state.settings.adminAllowlist).toEqual(["203.0.113.0/24"]))
  })

  it("refuses a duplicate allowlist entry", async () => {
    const { user } = await renderStudio("/settings")
    const field = await screen.findByLabelText("Address or CIDR range")
    await user.type(field, "::1")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.type(field, "::1")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("::1 is already in the list.")).toBeTruthy()
  })

  it("lists admins and realtime image status", async () => {
    const { api } = await renderStudio("/settings")
    expect(await screen.findByText("owner@example.com")).toBeTruthy()
    expect(screen.getByText("No collection has realtime turned on.")).toBeTruthy()
    await api.updateCollection("todos", { realtime: true, expectedVersion: 0 })
    expect(screen.getByText(/canopy realtime enable-images/)).toBeTruthy()
  })

  it("shows the danger zone to owners only", async () => {
    await renderStudio("/settings", { admins: [adminOf("admin")] })
    expect(await screen.findByLabelText("Address or CIDR range")).toBeTruthy()
    expect(screen.queryByText("Danger zone")).toBeNull()
  })

  it("requires the exact phrase before revoking all sessions", async () => {
    const { user, mock } = await renderStudio("/settings")
    await user.click(await screen.findByRole("button", { name: "Revoke all sessions" }))
    const confirm = lastDialog().getByRole("button", {
      name: "Revoke all sessions",
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const typed = lastDialog().getByLabelText("Type revoke all sessions to confirm")
    await user.type(typed, "revoke all session")
    expect(confirm.disabled).toBe(true)
    await user.type(typed, "s")
    expect(confirm.disabled).toBe(false)
    await user.click(confirm)
    await waitFor(() =>
      expect(mock.state.audit.some((entry) => entry.action === "danger.revoke_all_sessions")).toBe(
        true,
      ),
    )
  })

  it("seals stored secrets again with the current master key after the typed phrase", async () => {
    const { user, mock } = await renderStudio("/settings")
    await user.click(await screen.findByRole("button", { name: "Rotate the master key" }))
    await user.type(
      lastDialog().getByLabelText("Type rotate master key to confirm"),
      "rotate master key",
    )
    await user.click(lastDialog().getByRole("button", { name: "Rotate the master key" }))
    await screen.findByText("Stored secrets now use the current master key")
    expect(mock.state.audit.some((entry) => entry.action === "danger.rotate_master_key")).toBe(true)
  })

  it("keeps settings from viewers, who lack settings.read", async () => {
    await renderStudio("/settings", { admins: [adminOf("viewer")] })
    expect(await screen.findByText("Your role can view settings but not change them.")).toBeTruthy()
    expect(screen.queryByLabelText("Address or CIDR range")).toBeNull()
    expect(screen.queryByLabelText("Sample rate (percent of requests)")).toBeNull()
  })

  it("parses the numeric fields", () => {
    expect(retentionOf("")).toBeNull()
    expect(retentionOf("0")).toBeUndefined()
    expect(sampleRateOf("100")).toBe(1)
    expect(sampleRateOf("0")).toBe(0)
    expect(sampleRateOf("-1")).toBeUndefined()
    expect(sampleRateOf("1e2")).toBeUndefined()
    expect(logRetentionOf("90")).toBe(90)
    expect(logRetentionOf("91")).toBeUndefined()
    expect(isOrigin("https://app.example.com")).toBe(true)
    expect(isOrigin("https://app.example.com/")).toBe(false)
  })

  it("matches addresses like the server", () => {
    expect(isAddressRule("2001:db8::/32")).toBe(true)
    expect(isAddressRule("10.0.0.0/33")).toBe(false)
    expect(addressAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true)
    expect(addressAllowed("11.0.0.1", ["10.0.0.0/8"])).toBe(false)
    expect(addressAllowed(undefined, ["10.0.0.0/8"])).toBe(false)
    expect(addressAllowed("anything", [])).toBe(true)
  })
})
