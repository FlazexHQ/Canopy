import { allow, auth, collection } from "@canopy/policy"

export default collection("items", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") }), allow.read("viewer")],
})
