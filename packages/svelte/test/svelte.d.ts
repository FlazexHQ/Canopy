declare module "*.svelte" {
  import type { Component } from "svelte"
  import type { Query } from "../src/index.ts"

  const component: Component<{ readonly query: Query<{ readonly _id: number }> }>
  export default component
}
