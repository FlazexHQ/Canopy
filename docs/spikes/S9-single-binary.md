# S9: Single binary distribution

- **Date:** recorded 2026-11-13
- **Status:** done. Decision: ship `bun build --compile` executables next to the container image. Measured on
  Windows only; Linux and macOS are covered by the CI smoke steps but no numbers were collected there.
- **Roadmap:** [12 §4](../plan/12-roadmap.md#4-technical-spikes) and open item O3,
  [ADR 0001](../adr/0001-typescript-6-and-bun.md)

## Question

`bun build --compile`, Node SEA, or containers only? Success criterion: build, measure size and startup, test
on three operating systems, record the decision.

## Decision

`deploy/binary/build.ts` builds two executables with `bun build --compile --minify` for every Bun target
(Linux x64 and arm64, glibc and musl, macOS x64 and arm64, Windows x64 and arm64): `canopy` (the CLI) and
`canopy-server`. Each embeds the Bun runtime and every workspace package, so it runs on a machine without Bun,
Node or `node_modules`. Policy and config files load from disk and import `@canopy/policy` and
`@canopy/config`; a generated entry hands those imports the copies inside the executable. `SHA256SUMS` is
written next to the files. Node SEA was not tried: it would need a separate bundling step and would drop the
Bun runtime that the server uses as its primary one. Containers stay the production default
(`deploy/docker`, `deploy/compose`).

## Measurements

Windows 11 x64, Bun 1.4.4, MongoDB 8.0.34 replica set on the same machine, a policy folder with one
collection, 2026-11-13.

| | `canopy.exe` | `canopy-server.exe` |
|---|---|---|
| File size | 116.5 MB | 116.3 MB |
| Build time (both) | about 2.4 s | |
| `--version`, five runs | 237 to 267 ms | |
| Server until `/readyz` answers | | 0.6 s warm (three runs: 1.8 s, 0.6 s, 0.6 s) |

Minification saves about 5.5 MB per executable (Bun's estimate); most of the size is the Bun runtime.
The source maps (10 MB each) are written next to the executables and are not needed to run.

Checks run against the executables on this machine: `canopy policies lint`, a REST insert with a secret key,
and a realtime WebSocket round trip (connect, subscribe, mutate, ack) through `deploy/binary/ws-smoke.ts`.

## Operating systems

CI builds and starts the executables on Linux (the compose job, Linux x64) and on Windows and macOS (the Bun
job matrix), each time running `canopy --version`, `canopy policies lint`, a REST insert and the WebSocket
round trip. Sizes and startup times of the Linux and macOS runs were not recorded.

## Defects found while measuring

Both executables failed at startup on `master`:

- **tsyringe found no `Reflect.getMetadata`.** Bun's bundler runs the CommonJS import of `reflect-metadata`
  after the ES modules next to it, so `tsyringe` (used by `@peculiar/x509`, a dependency of the passkey
  support) checked for the polyfill too early. The generated entry now imports `reflect-metadata` first.
- **`canopy --version` read a missing `package.json`.** The build now embeds the version as
  `CANOPY_BUILD_VERSION`, and CI runs `canopy --version`.

Both would have failed the CI smoke steps since the passkey commit; the fixes are in the commit
`fix(build): start the standalone executables again and embed the CLI version`.
