import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordPipelines } from "../../policy/test/conformance/pipeline/record.ts"

/**
 * Records what the TypeScript `securePipeline` of `@canopy/policy` makes of caller aggregation pipelines
 * (`conformance/policy/pipeline.json`) for the Rust `canopy-policy` crate: the secured pipeline as canonical EJSON,
 * or the refusal. With `--check` nothing is written and the exit code is 1 when the file would change.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/pipeline-vectors.ts [--out <file>] [--check]
 *
 * It needs no database.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    out: { type: "string", default: resolve(root, "conformance/policy/pipeline.json") },
    check: { type: "boolean", default: false },
  },
})

const differs = await recordPipelines({ file: values.out, check: values.check })
if (values.check) {
  if (differs) {
    process.stderr.write(`${values.out} differs from a fresh computation\n`)
    process.exit(1)
  }
  process.stdout.write("conformance/policy/pipeline.json is current\n")
} else {
  process.stdout.write(`Wrote ${values.out}\n`)
}
