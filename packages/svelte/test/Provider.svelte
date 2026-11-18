<script lang="ts">
import type { CanopyClient } from "@canopy/client"
import { setCanopy } from "../src/index.ts"
import Consumer from "./Consumer.svelte"

const props: { client: CanopyClient } = $props()
setCanopy(props.client)
</script>

<Consumer />
