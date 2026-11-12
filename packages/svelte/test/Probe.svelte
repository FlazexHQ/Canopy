<script lang="ts">
import type { Query } from "../src/index.ts"

let { query }: { query: Query<{ _id: number }> } = $props()
</script>

<p>{query.status}:{query.data.length}</p>
