/**
 * The Rust part of `bun run check`: `cargo fmt --check`, Clippy with warnings denied, the crate tests and,
 * when `cargo-deny` is installed, `cargo deny check`. A machine without a Rust toolchain skips the whole
 * step with a note, because nothing a user installs needs Rust; CI always has one.
 *
 *   bun packages/testing/scripts/rust-check.ts
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../..", import.meta.url))

function available(args: readonly string[]): boolean {
  const probe = spawnSync("cargo", [...args, "--version"], { cwd: root, stdio: "ignore" })
  return probe.error === undefined && probe.status === 0
}

const STEPS: readonly (readonly string[])[] = [
  ["fmt", "--all", "--check"],
  ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
  ["test", "--locked"],
]

if (!available([])) {
  process.stdout.write("No Rust toolchain (cargo) on the PATH: the Rust checks are skipped.\n")
  process.exit(0)
}

const steps = available(["deny"]) ? [...STEPS, ["deny", "--locked", "check"]] : STEPS
if (steps === STEPS) {
  process.stdout.write("cargo-deny is not installed: cargo deny check is skipped.\n")
}
for (const args of steps) {
  process.stdout.write(`cargo ${args.join(" ")}\n`)
  const result = spawnSync("cargo", [...args], { cwd: root, stdio: "inherit" })
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(`cargo ${args.join(" ")} failed\n`)
    process.exit(result.status ?? 1)
  }
}
