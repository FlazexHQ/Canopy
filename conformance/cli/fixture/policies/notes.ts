import { allow, auth, collection } from "@canopy/policy"

export default collection("notes", {
  exposed: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") }).named("read own")],
})
