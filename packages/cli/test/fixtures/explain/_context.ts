import { auth, context } from "@canopy/policy"

export default context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 100,
    ttl: "1m",
  },
})
