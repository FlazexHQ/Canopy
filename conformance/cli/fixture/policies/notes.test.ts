import { as, describePolicies } from "@canopy/policy/testing"

describePolicies("notes", ({ doc, expect }) => {
  const note = doc({ _id: "fixture", ownerId: "alice", title: "Fixture note" })
  expect(as.user({ sub: "alice" })).can.read(note)
  expect(as.user({ sub: "bob" })).cannot.read(note)
})
