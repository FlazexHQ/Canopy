import { allow, collection, ctx } from "@canopy/policy"

export default collection("tasks", {
  exposed: true,
  policies: [
    allow
      .read("authenticated")
      .where({ projectId: { $in: ctx("projectIds") } })
      .named("in my projects"),
    allow.read("staff").named("staff reads all"),
  ],
  fields: { read: { default: { omit: ["secret"] }, staff: { only: ["*"] } } },
})
