import { ConfigError } from "@canopy/config"
import { PolicyValidationError } from "@canopy/policy"
import { CanopyError, ErrorCode, InvalidQueryError } from "@canopy/protocol"
import { ConfigError as SdkConfigError } from "canopy.js/config"
import { PolicyValidationError as SdkPolicyValidationError } from "canopy.js/policy"
import { describe, expect, it } from "vitest"

describe("Canopy error identity across the platform and SDK", () => {
  it("recognizes configuration errors in either direction", () => {
    const problems = [{ path: "mongodb.uri", message: "Required", missing: true }]
    expect(new SdkConfigError(undefined, problems)).toBeInstanceOf(ConfigError)
    expect(new ConfigError(undefined, problems)).toBeInstanceOf(SdkConfigError)
    expect(new CanopyError(ErrorCode.ConfigInvalid, "Invalid config")).not.toBeInstanceOf(
      SdkConfigError,
    )
  })

  it("preserves inherited types and distinguishes errors that share a code", () => {
    const error = new SdkPolicyValidationError("notes", "Invalid clause")
    expect(error).toBeInstanceOf(PolicyValidationError)
    expect(error).toBeInstanceOf(InvalidQueryError)
    expect(new InvalidQueryError("Invalid query")).not.toBeInstanceOf(SdkPolicyValidationError)
  })
})
