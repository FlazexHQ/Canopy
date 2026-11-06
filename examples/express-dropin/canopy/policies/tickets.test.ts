import { as, describePolicies } from "@canopy/policy/testing"

describePolicies("tickets", ({ doc, expect }) => {
  const alice = as.user({ sub: "dev|alice" })
  const bob = as.user({ sub: "dev|bob" })
  const sam = as.user({ sub: "dev|sam" }, { roles: ["support"] })
  const ticket = doc({
    _id: "t1",
    title: "VPN drops every hour",
    ownerId: "dev|alice",
    ownerName: "Alice",
    status: "open",
    internalNotes: "Known issue with the old client",
  })

  expect(alice).can.read(ticket).withoutFields(["internalNotes"])
  expect(bob).cannot.read(ticket)
  expect(sam).can.read(ticket).withFields(["internalNotes"])
  expect(as.anon()).cannot.read(ticket)
  expect(as.user({ email: "no-subject@example.com" })).cannot.read(ticket)
  expect(alice).cannot.update(ticket, { $set: { status: "closed" } })
  expect(sam).cannot.delete(ticket)
  expect(alice).cannot.insert({ _id: "t2", title: "New", ownerId: "dev|alice" })
})
