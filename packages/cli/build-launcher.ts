import { fileURLToPath } from "node:url"

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./launcher.ts", import.meta.url))],
  outdir: process.argv[2] ?? fileURLToPath(new URL("./dist", import.meta.url)),
  target: "node",
  format: "esm",
  naming: "launcher.mjs",
})
if (!result.success) throw new AggregateError(result.logs, "Could not build the Canopy launcher")
