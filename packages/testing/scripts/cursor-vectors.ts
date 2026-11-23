import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordCursor } from "../../rest/test/conformance/cursor/record.ts"

/**
 * Records the keyset cursor reference data of the TypeScript `@canopy/rest` (`conformance/cursor`) for the Rust
 * `canopy-data` crate: the query hashes, the keyset filters and the encoded cursors of fixed inputs. With
 * `--check` nothing is written and the exit code is 1 when a file would change.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/cursor-vectors.ts [--dir <folder>] [--check]
 *
 * It needs no database.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    dir: { type: "string", default: resolve(root, "conformance/cursor") },
    check: { type: "boolean", default: false },
  },
})

const differing = await recordCursor({ dir: values.dir, check: values.check })
if (values.check) {
  if (differing.length > 0) {
    process.stderr.write(`These files differ from a fresh computation: ${differing.join(", ")}\n`)
    process.exit(1)
  }
  process.stdout.write("conformance/cursor is current\n")
} else {
  process.stdout.write(`Wrote ${values.dir}\n`)
}
