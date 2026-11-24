import { describe, expect, it } from "vitest"
import { hostTarget, linuxLibc, NATIVE_TARGETS, targetFor } from "../src/targets.ts"

const GLIBC_LDD = "#! /bin/bash\n# This file is part of the GNU C Library.\nTEXTDOMAIN=libc\n"
const MUSL_LDD = '#!/bin/sh\nexec /lib/ld-musl-x86_64.so.1 --list -- "$@"\n'

const unreadable = (): never => {
  throw new Error("ENOENT: no such file or directory, open '/usr/bin/ldd'")
}

describe("linuxLibc", () => {
  it("reads the C library from the runtime version in the diagnostic report", () => {
    expect(linuxLibc(() => ({ header: { glibcVersionRuntime: "2.39" } }), unreadable)).toBe("glibc")
    expect(linuxLibc(() => ({ header: { glibcVersionCompiler: "2.28" } }), unreadable)).toBe("musl")
    expect(
      linuxLibc(
        () => ({ header: { glibcVersionRuntime: "" } }),
        () => GLIBC_LDD,
      ),
    ).toBe("musl")
  })

  it("trusts the report over ldd when the report has a header", () => {
    expect(
      linuxLibc(
        () => ({ header: {} }),
        () => GLIBC_LDD,
      ),
    ).toBe("musl")
    expect(
      linuxLibc(
        () => ({ header: { glibcVersionRuntime: "2.17" } }),
        () => MUSL_LDD,
      ),
    ).toBe("glibc")
  })

  it("falls back to ldd when there is no report or it fails", () => {
    expect(
      linuxLibc(
        () => undefined,
        () => MUSL_LDD,
      ),
    ).toBe("musl")
    expect(
      linuxLibc(
        () => ({}),
        () => MUSL_LDD,
      ),
    ).toBe("musl")
    expect(
      linuxLibc(
        () => undefined,
        () => GLIBC_LDD,
      ),
    ).toBe("glibc")
    expect(linuxLibc(unreadable, () => MUSL_LDD)).toBe("musl")
  })

  it("assumes glibc when neither the report nor ldd can be read", () => {
    expect(linuxLibc(unreadable, unreadable)).toBe("glibc")
  })
})

describe("targetFor", () => {
  it("finds every prebuilt target by operating system, processor and C library", () => {
    for (const target of NATIVE_TARGETS)
      expect(targetFor(target.os, target.cpu, target.libc)).toBe(target)
    expect(targetFor("linux", "x64", "musl")?.triple).toBe("x86_64-unknown-linux-musl")
    expect(targetFor("linux", "arm64", "glibc")?.suffix).toBe("linux-arm64-gnu")
    expect(targetFor("win32", "arm64", undefined)?.suffix).toBe("win32-arm64-msvc")
  })

  it("has no target for unsupported processors or a Linux target without its C library", () => {
    expect(targetFor("linux", "ia32", "glibc")).toBeUndefined()
    expect(targetFor("freebsd", "x64", undefined)).toBeUndefined()
    expect(targetFor("linux", "x64", undefined)).toBeUndefined()
    expect(targetFor("darwin", "arm64", "glibc")).toBeUndefined()
  })

  it("matches this process", () => {
    const host = hostTarget()
    expect(host?.os).toBe(process.platform)
    expect(host?.cpu).toBe(process.arch)
    expect(host?.libc === undefined).toBe(process.platform !== "linux")
  })
})
