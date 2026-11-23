import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordRateLimits } from "../../auth/test/conformance/rate-limits/record.ts"

/**
 * Records what the token buckets and request limits of `@canopy/auth` answer to seeded sequences of operations
 * on a fake clock (`conformance/auth/rate-limits.json`) for the Rust `canopy-auth` crate. With `--check` nothing
 * is written and the exit code is 1 when the file would change.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/rate-limit-vectors.ts [--out <file>] [--check]
 *
 * It needs no database.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    out: { type: "string", default: resolve(root, "conformance/auth/rate-limits.json") },
    check: { type: "boolean", default: false },
  },
})

const differs = await recordRateLimits({ file: values.out, check: values.check })
if (values.check) {
  if (differs) {
    process.stderr.write(`${values.out} differs from a fresh computation\n`)
    process.exit(1)
  }
  process.stdout.write("conformance/auth/rate-limits.json is current\n")
} else {
  process.stdout.write(`Wrote ${values.out}\n`)
}
