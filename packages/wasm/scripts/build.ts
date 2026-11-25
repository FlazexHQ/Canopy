import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Builds the WebAssembly port into `generated/`: compiles the `canopy-wasm` crate for
 * `wasm32-unknown-unknown`, then runs wasm-bindgen for the web target, which Cloudflare Workers, browsers,
 * Bun, Node and Deno all load.
 *
 *   bun scripts/build.ts
 *
 * The wasm-bindgen CLI must be the version of the `wasm-bindgen` crate in `Cargo.lock`. One on the PATH is
 * used when its version matches; otherwise the release archive of this platform is downloaded once into
 * `target/wasm-bindgen/`, checked against the SHA-256 recorded below, and used from there.
 */
const packageDir = fileURLToPath(new URL("..", import.meta.url))
const root = join(packageDir, "..", "..")
const generated = join(packageDir, "generated")
const TARGET = "wasm32-unknown-unknown"

const ARCHIVE_VERSION = "0.2.130"

/** SHA-256 of each wasm-bindgen release archive. Update with `Cargo.lock`. */
const ARCHIVES: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f",
  "aarch64-unknown-linux-gnu": "cc8dd8e90aa9111758168d30c63a14b7f0276997d9d60d3e160a1fb5e7d3b919",
  "x86_64-apple-darwin": "eb209c115b7cb95832423c1aa3f4d06d6c53f63ef74fc4b6fb79ef0b2eea5f10",
  "aarch64-apple-darwin": "b90ddb9357f584b1af897d58ad77e4cce2b48fc17e2a967bc249a87f72809444",
  "x86_64-pc-windows-msvc": "844d23f1b56097549b936dd2e0d561fadebc1e8c9e985d5068b6b919654104ad",
}

const HOSTS: Readonly<Record<string, string>> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
}

function run(
  command: string,
  args: readonly string[],
  cwd = root,
  input?: Uint8Array,
  env = process.env,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`)
  return result.stdout
}

function lockedVersion(crate: string): string {
  const lock = readFileSync(join(root, "Cargo.lock"), "utf8").replaceAll("\r\n", "\n")
  const match = new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`).exec(
    lock,
  )
  if (match?.[1] === undefined) throw new Error(`Cargo.lock does not list ${crate}`)
  return match[1]
}

function versionOf(command: string): string | undefined {
  try {
    return run(command, ["--version"]).trim()
  } catch {
    return undefined
  }
}

async function download(version: string): Promise<string> {
  const install = `cargo install wasm-bindgen-cli --version ${version} --locked`
  const host = HOSTS[`${process.platform}-${process.arch}`]
  const sha256 = host === undefined ? undefined : ARCHIVES[host]
  if (version !== ARCHIVE_VERSION || host === undefined || sha256 === undefined) {
    throw new Error(`No recorded wasm-bindgen ${version} archive for this platform: ${install}`)
  }
  const name = `wasm-bindgen-${ARCHIVE_VERSION}-${host}`
  const dir = join(root, "target", "wasm-bindgen")
  const binary = join(dir, name, process.platform === "win32" ? "wasm-bindgen.exe" : "wasm-bindgen")
  if (existsSync(binary)) return binary
  const url = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${name}.tar.gz`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}: ${install}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== sha256) throw new Error(`${url} has SHA-256 ${actual}, expected ${sha256}`)
  mkdirSync(dir, { recursive: true })
  run("tar", ["-xzf", "-"], dir, archive)
  return binary
}

async function main(): Promise<void> {
  const version = lockedVersion("wasm-bindgen")
  const bindgen =
    versionOf("wasm-bindgen") === `wasm-bindgen ${version}`
      ? "wasm-bindgen"
      : await download(version)
  run("rustup", ["target", "add", TARGET])
  const target = resolve(root, process.env["CARGO_TARGET_DIR"] ?? "target")
  const input = join(target, TARGET, "release", "canopy_wasm.wasm")
  const cargo = ["build", "-j", "2", "--locked", "--target", TARGET, "-p", "canopy-wasm"]
  mkdirSync(generated, { recursive: true })
  if (!process.argv.includes("--split")) {
    run("cargo", [...cargo, "--release"])
    run(bindgen, [
      input,
      "--target",
      "web",
      "--out-dir",
      generated,
      "--out-name",
      "canopy_wasm",
      "--no-typescript",
    ])
    return
  }

  const optimizer = process.env["CANOPY_WASM_OPT"] ?? "wasm-opt"
  const translator = process.env["CANOPY_WASM2JS"] ?? "wasm2js"
  for (const tool of [optimizer, translator]) {
    if (!versionOf(tool)?.includes("version 133")) {
      throw new Error(`${tool} must be from Binaryen version 133`)
    }
  }
  const features = [
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-nontrapping-float-to-int",
    "--enable-mutable-globals",
  ]
  const splitInput = join(target, TARGET, "wasm", "canopy_wasm.wasm")
  for (const feature of ["client", "transforms", "authoring"]) {
    const name = `canopy_${feature}`
    const dir = join(generated, feature)
    const speed = feature === "transforms"
    const env = {
      ...process.env,
      ...(speed ? { CARGO_PROFILE_WASM_OPT_LEVEL: "3" } : {}),
      RUSTFLAGS:
        `${process.env["RUSTFLAGS"] ?? ""} -C target-feature=-reference-types,-multivalue -C panic=abort`.trim(),
    }
    run(
      "cargo",
      [...cargo, "--profile", "wasm", "--no-default-features", "--features", feature],
      root,
      undefined,
      env,
    )
    mkdirSync(dir, { recursive: true })
    const portable = join(target, `${name}_portable.wasm`)
    run(optimizer, [...features, "--strip-target-features", splitInput, "-o", portable])
    const bindgenEnv: Record<string, string | undefined> = { ...env }
    delete bindgenEnv["WASM_BINDGEN_ANYREF"]
    delete bindgenEnv["WASM_BINDGEN_EXTERNREF"]
    delete bindgenEnv["WASM_BINDGEN_MULTI_VALUE"]
    run(
      bindgen,
      [
        portable,
        "--target",
        "web",
        "--out-dir",
        dir,
        "--out-name",
        name,
        "--remove-name-section",
        "--remove-producers-section",
      ],
      root,
      undefined,
      bindgenEnv,
    )
    const wasm = join(dir, `${name}_bg.wasm`)
    run(optimizer, [
      speed ? "-O3" : "-Oz",
      "--converge",
      "--strip-debug",
      ...features,
      wasm,
      "-o",
      wasm,
    ])
    if (feature === "client") {
      run(optimizer, [
        "--flatten",
        "--dfo",
        "--rereloop",
        "-Oz",
        "--converge",
        ...features,
        wasm,
        "-o",
        wasm,
      ])
    }
    const translated = join(dir, `${name}_translated.js`)
    run(translator, ["-O", "--pedantic", "--emscripten", ...features, wasm, "-o", translated])
    writeFileSync(translated, `${readFileSync(translated, "utf8")}\nexport { instantiate };\n`)
    const glue = readFileSync(join(dir, `${name}.js`), "utf8")
    const loader = glue.indexOf("let wasmModule, wasmInstance, wasm;")
    if (loader < 0) throw new Error("The wasm-bindgen initializer has changed")
    // Binaryen replaces the buffer on growth without detaching existing views.
    const bindings = glue.slice(0, loader)
    const views = bindings
      .replace(/\b(cached\w+Memory\d+)\.byteLength === 0/g, "$1.buffer !== wasm.memory.buffer")
      .replace(
        /\b(cached\w+Memory\d+)\.buffer\.detached === true \|\| \(\1\.buffer\.detached === undefined && \1\.buffer !== wasm\.memory\.buffer\)/g,
        "$1.buffer !== wasm.memory.buffer",
      )
    if (views === bindings) throw new Error("The wasm-bindgen memory cache has changed")
    const bridge = `import { instantiate } from "./${name}_translated.js";
let wasm = instantiate(__wbg_get_imports());
wasm.__wbindgen_start?.();
`
    writeFileSync(
      join(dir, `${name}_js.js`),
      views.replace(`./${name}.d.ts`, `./${name}_js.d.ts`) + bridge,
    )
    const types = readFileSync(join(dir, `${name}.d.ts`), "utf8")
    const initTypes = types.indexOf("export type InitInput")
    if (initTypes < 0) throw new Error("The wasm-bindgen initializer types have changed")
    writeFileSync(join(dir, `${name}_js.d.ts`), types.slice(0, initTypes))
  }
  const transforms = join(generated, "transforms")
  writeFileSync(
    join(transforms, "load.js"),
    `let loading;
export function loadTransforms(source) {
    loading ??= (async () => {
        if (typeof WebAssembly === "undefined") return import("./canopy_transforms_js.js");
        const binding = await import("./canopy_transforms.js");
        await binding.default(source === undefined ? undefined : { module_or_path: source });
        return binding;
    })().catch(error => {
        loading = undefined;
        throw error;
    });
    return loading;
}
`,
  )
  writeFileSync(
    join(transforms, "load.d.ts"),
    `import type { InitInput, DocumentPage, engine } from "./canopy_transforms.js";

/** Loads the document transform bindings on first use. Pass bytes or a response when needed by the host. */
export function loadTransforms(source?: InitInput): Promise<{
    DocumentPage: typeof DocumentPage;
    engine: typeof engine;
}>;
`,
  )
}

await main()
