declare module "*.svelte" {
  import type { CanopyClient } from "@canopy/client"
  import type { Component } from "svelte"
  import type { Query } from "../src/index.ts"

  const component: Component<{
    readonly query?: Query<{ readonly _id: number }>
    readonly client?: CanopyClient
  }>
  export default component
}
