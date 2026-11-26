import { chmodSync, existsSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { NativeTarget } from "@canopy/native"

/** The npm package with the prebuilt `canopyd` of a platform, such as `@canopy/canopyd-linux-x64-musl`. */
export function gatewayPackage(target: NativeTarget): string {
  return `@canopy/canopyd-${target.suffix}`
}

/** The file name of the `canopyd` executable on an operating system. */
export function gatewayExecutable(os: NativeTarget["os"] | NodeJS.Platform): string {
  return os === "win32" ? "canopyd.exe" : "canopyd"
}

/**
 * Lets the owner and everyone who may read a file also execute it, since a package manager can unpack a
 * tarball without its permission bits. This only makes the file runnable and is never a security check.
 */
export function ensureExecutable(file: string): void {
  try {
    const mode = statSync(file).mode & 0o777
    const execute = (mode & 0o444) >> 2
    if ((mode & execute) !== execute) chmodSync(file, mode | execute)
  } catch {}
}

/**
 * The `canopyd` of the platform package for `target`, resolved the way a module in the folder `from` resolves
 * its dependencies, so it works in the node_modules layouts of Bun, pnpm, Yarn and npm. On POSIX systems it is
 * made executable when the package manager dropped the permission bits. `undefined` when the package or its
 * executable is not installed.
 */
export function packagedGateway(
  target: NativeTarget | undefined,
  from: string,
): string | undefined {
  if (target === undefined) return undefined
  let manifest: string
  try {
    manifest = createRequire(join(from, "index.js")).resolve(
      `${gatewayPackage(target)}/package.json`,
    )
  } catch {
    return undefined
  }
  const binary = join(dirname(manifest), gatewayExecutable(target.os))
  if (!existsSync(binary)) return undefined
  if (process.platform !== "win32") ensureExecutable(binary)
  return binary
}
