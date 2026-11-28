---
"@canopy/realtime": minor
"@canopy/native": minor
---

Ship `canopyd` prebuilt as npm packages, one per platform: `@canopy/canopyd-win32-x64-msvc`,
`-win32-arm64-msvc`, `-darwin-x64`, `-darwin-arm64`, `-linux-x64-gnu`, `-linux-x64-musl`, `-linux-arm64-gnu`
and `-linux-arm64-musl`, each limited to its platform by its `os`, `cpu` and `libc` fields. The released
`@canopy/realtime` names them as optional dependencies, so installing the CLI or the server with Bun, pnpm,
Yarn or npm brings the binary for the machine, and `canopy dev` with the gateway runs it without a Rust
toolchain.

`findGatewayBinary` now looks for the installed platform package right after `CANOPYD_BIN` (and the legacy
`CANOPY_GATEWAY_BIN`), before Cargo builds, a binary beside the running executable and `PATH`. It detects
musl on Linux as `@canopy/native` does, takes the target as a new optional fourth parameter, and restores the
execute bit when a package manager unpacked the binary without it. When no binary is found, the error names
the package to install for the platform.

`@canopy/native` exports `NATIVE_TARGETS`, `NativeTarget`, `hostTarget` and `targetFor`, the prebuilt targets
and the detection of the target of this process.
